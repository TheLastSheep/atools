#!/usr/bin/env python3
"""Headless check of original Vue controls; all login-item RPC replies are synthetic, not Rust/SQLite/OS."""

from __future__ import annotations

import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
from urllib.parse import urlsplit

from playwright.sync_api import BrowserContext, Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/lib"))
from ztools_settings_login_preview_paths import (
    RUN_ID_RE,
    capture_owned_screenshot,
    owned_bootstrap,
    owned_output_dir,
)

NODE = ROOT / "src-tauri/binaries/node-aarch64-apple-darwin"
HELPER = ROOT / "scripts/lib/ztools-settings-login-preview.mjs"
URL_PATH = "/setting/index.html#/generalSetting"
NODE_TIMEOUT_SECONDS = 45
NODE_SHUTDOWN_SECONDS = 12
PAGE_TIMEOUT_MS = 12_000
NAVIGATION_TIMEOUT_MS = 25_000
EXPECTED_CHECK_COUNT = 14


def exact_keys(value: object, expected: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == expected


class NodePreview:
    def __init__(self) -> None:
        if not NODE.is_file() or not os.access(NODE, os.X_OK): raise RuntimeError("Product Node v22.23.3 executable is unavailable")
        self.process = subprocess.Popen(
            [str(NODE), str(HELPER), "--serve"],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self.events: queue.Queue[tuple[str, str | None]] = queue.Queue()
        self.stderr_lines: list[str] = []
        self.stderr_truncated = False
        self.ready: dict | None = None
        self.closed: dict | None = None
        self._stdout_thread = threading.Thread(target=self._pump_stdout, daemon=True)
        self._stderr_thread = threading.Thread(target=self._pump_stderr, daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()

    def _pump_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.events.put(("line", line))
        self.events.put(("stdout-eof", None))

    def _pump_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            if sum(map(len, self.stderr_lines)) < 16 * 1024:
                self.stderr_lines.append(line.rstrip("\n"))
            else:
                self.stderr_truncated = True

    def next_event(self, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Owned login-preview Node helper did not produce its next record")
            try:
                kind, line = self.events.get(timeout=remaining)
            except queue.Empty as error:
                raise TimeoutError("Owned login-preview Node helper record timed out") from error
            if kind == "stdout-eof": raise RuntimeError(self._exit_summary("Node helper exited before its closed record"))
            try:
                value = json.loads(line or "")
            except json.JSONDecodeError as error:
                raise RuntimeError("Node helper emitted a non-JSON protocol line") from error
            if not isinstance(value, dict):
                raise RuntimeError("Node helper protocol record must be an object")
            return value

    def start(self) -> dict:
        record = self.next_event(NODE_TIMEOUT_SECONDS)
        expected = {
            "type", "schemaVersion", "runId", "origin", "outputDir", "bootstrapPath",
            "bootstrapSha256", "fixtureBundleSha256", "sourceIdentity", "staticServer",
        }
        if not exact_keys(record, expected) or record.get("type") != "ready" or record.get("schemaVersion") != 1:
            raise RuntimeError("Node helper ready record has an invalid schema")
        if not isinstance(record.get("runId"), str) or not RUN_ID_RE.fullmatch(record["runId"]):
            raise RuntimeError("Node helper run identifier is invalid")
        parts = urlsplit(record.get("origin", ""))
        if (parts.scheme != "http" or parts.hostname != "127.0.0.1" or not parts.port
                or parts.username or parts.password or parts.path or parts.query or parts.fragment):
            raise RuntimeError("Node helper did not bind an owned loopback origin")
        if record.get("staticServer") != {"host": "127.0.0.1", "randomPort": parts.port}:
            raise RuntimeError("Node helper static-server binding does not match its origin")
        bootstrap_path = owned_bootstrap(ROOT, record)
        bootstrap = bootstrap_path.read_bytes()
        if hashlib.sha256(bootstrap).hexdigest() != record.get("bootstrapSha256"):
            raise RuntimeError("Node helper bootstrap hash did not match its record")
        self.ready = record
        return record

    def _exit_summary(self, prefix: str) -> str:
        code = self.process.poll()
        detail = "\n".join(self.stderr_lines)
        return f"{prefix} (exit={code}; stderr={detail[:1000]})"

    def stop(self) -> dict | None:
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=NODE_SHUTDOWN_SECONDS)
        except subprocess.TimeoutExpired:
            # The process handle is the unique helper started by this runner.
            self.process.kill()
            self.process.wait(timeout=3)
        self._stdout_thread.join(timeout=2)
        self._stderr_thread.join(timeout=2)
        while True:
            try:
                kind, line = self.events.get_nowait()
            except queue.Empty:
                break
            if kind != "line" or line is None:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and value.get("type") == "closed":
                self.closed = value
        expected = {"type", "schemaVersion", "runId", "sourceIdentity", "staticServer"}
        if not exact_keys(self.closed, expected) or self.closed.get("schemaVersion") != 1:
            self.closed = None
        elif self.ready is None or self.closed.get("runId") != self.ready.get("runId"):
            self.closed = None
        return self.closed


def assert_record(report: dict, name: str, passed: bool, facts: dict | None = None) -> None:
    report["checks"].append({"name": name, "passed": passed, "facts": facts or {}})
    if not passed:
        raise AssertionError(f"browser check failed: {name}")


def login_row(page: Page):
    label = page.get_by_text("开机自动启动", exact=True)
    if label.count() != 1: raise AssertionError("The original General launch-at-login label is not unique")
    row = label.locator(
        "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' setting-item ')][1]"
    )
    if row.count() != 1: raise AssertionError("The original General setting-item row was not found")
    checkbox = row.locator('input[type="checkbox"]')
    if checkbox.count() != 1: raise AssertionError("The original launch-at-login checkbox is not unique")
    return row, checkbox


def preview_snapshot(page: Page) -> dict:
    value = page.evaluate("() => window.__ATOOLS_SETTINGS_LOGIN_PREVIEW__?.snapshot?.() ?? null")
    if not isinstance(value, dict): raise AssertionError("Synthetic launch-at-login transport snapshot is unavailable")
    return value


def count(snapshot: dict, operation: str) -> int:
    return int(snapshot.get("operationCounts", {}).get(operation, 0))


def wait_ready_checkbox(page: Page, checked: bool) -> None:
    _, checkbox = login_row(page)
    page.wait_for_function(
        "(expected) => { const row=[...document.querySelectorAll('.setting-item')].find(item => "
        "[...item.querySelectorAll('.setting-label span')].some(span => span.textContent.trim() === '开机自动启动')); "
        "const input=row?.querySelector('input[type=checkbox]'); "
        "return !!input && !input.disabled && input.checked === expected; }",
        arg=checked,
        timeout=PAGE_TIMEOUT_MS,
    )
    if checkbox.is_disabled() or checkbox.is_checked() != checked:
        raise AssertionError("Launch-at-login checkbox did not reach the expected ready state")


def wait_legacy(page: Page) -> None:
    choices = [page.get_by_role("button", name=label, exact=True) for label in
               ("暂不处理", "关闭旧启动项", "迁移到新机制")]
    for choice in choices:
        choice.wait_for(state="visible", timeout=PAGE_TIMEOUT_MS)
    if any(choice.count() != 1 for choice in choices):
        raise AssertionError("The original legacy decision controls must each be unique")
    row, checkbox = login_row(page)
    if not row.get_by_text("状态未知", exact=True).is_visible() or not checkbox.is_disabled() or checkbox.get_attribute("aria-checked") != "mixed" or not checkbox.evaluate("input => input.indeterminate"):
        raise AssertionError("Legacy state must be disabled and visibly indeterminate")


def open_general(context: BrowserContext, ready: dict, mode: str, console: dict, network: dict) -> Page:
    page = context.new_page()
    page.set_default_timeout(PAGE_TIMEOUT_MS)
    page.set_default_navigation_timeout(NAVIGATION_TIMEOUT_MS)

    def on_console(message) -> None:
        if message.type in {"error", "warning"}:
            console["messages"].append({"type": message.type, "text": message.text[:400]})

    page.on("console", on_console)
    page.on("pageerror", lambda error: console["pageErrors"].append(str(error)[:400]))
    bootstrap_path = owned_bootstrap(ROOT, ready)
    bootstrap = bootstrap_path.read_text(encoding="utf-8")
    page.add_init_script(
        f"window.__ATOOLS_SETTINGS_LOGIN_PREVIEW_MODE__ = {json.dumps(mode)};\n{bootstrap}"
    )
    page.goto(f"{ready['origin']}{URL_PATH}", wait_until="networkidle", timeout=NAVIGATION_TIMEOUT_MS)
    if page.url.split("#", 1)[-1] != "/generalSetting": raise AssertionError("The original Vue settings router did not open GeneralSetting")
    page.get_by_text("开机自动启动", exact=True).wait_for(state="visible", timeout=PAGE_TIMEOUT_MS)
    network["pagesOpened"] += 1
    return page


@contextmanager
def general_page(context: BrowserContext, ready: dict, mode: str, console: dict, network: dict) -> Iterator[Page]:
    page = open_general(context, ready, mode, console, network)
    try:
        yield page
    finally:
        page.close()


def run_browser(ready: dict, report: dict) -> None:
    report["fixtureBoundary"] = {
        "syntheticRpc": True,
        "sqlite": False,
        "rust": False,
        "nativeOS": False,
        "browser": "Playwright Chromium headless with a fresh ephemeral context",
        "externalNetwork": "all non-loopback requests are aborted",
    }
    report["checks"] = []
    report["screenshots"] = []
    report["scenarios"] = {}
    report["console"] = {"messages": [], "pageErrors": []}
    report["network"] = {"localRequests": 0, "externalAttempts": [], "pagesOpened": 0}
    origin = ready["origin"]
    expected = urlsplit(origin)

    with sync_playwright() as playwright:
        channel = "chromium" if Path(playwright.chromium.executable_path).is_file() else "chrome"
        browser = playwright.chromium.launch(headless=True, channel=channel)
        report["browser"] = {"channel": channel, "version": browser.version, "headless": True}
        context = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1)

        def route_request(route) -> None:
            request_url = urlsplit(route.request.url)
            if (request_url.scheme, request_url.netloc) == (expected.scheme, expected.netloc):
                report["network"]["localRequests"] += 1
                route.continue_()
            else:
                report["network"]["externalAttempts"].append({
                    "scheme": request_url.scheme,
                    "host": request_url.hostname,
                    "aborted": True,
                })
                route.abort()

        context.route("**/*", route_request)
        with general_page(context, ready, "legacy", report["console"], report["network"]) as page:
            wait_legacy(page)
            legacy_snapshot = preview_snapshot(page)
            assert_record(report, "legacy-initial-read-and-inspection", count(legacy_snapshot, "readLaunchAtLogin") == 1
                and count(legacy_snapshot, "inspectLegacyLaunchAtLogin") == 1,
                {"reads": count(legacy_snapshot, "readLaunchAtLogin"),
                 "inspections": count(legacy_snapshot, "inspectLegacyLaunchAtLogin")})
            capture_owned_screenshot(page, ROOT, ready, "legacy-resolution-options.png")
            report["screenshots"].append("legacy-resolution-options.png")
            page.get_by_role("button", name="暂不处理", exact=True).click()
            page.get_by_role("button", name="重新读取", exact=True).wait_for(state="visible", timeout=PAGE_TIMEOUT_MS)
            _, checkbox = login_row(page)
            deferred = preview_snapshot(page)
            assert_record(report, "defer-preserves-unknown-without-mutation",
                checkbox.is_disabled() and checkbox.get_attribute("aria-checked") == "mixed"
                and deferred["resolveMutationCount"] == 0
                and count(deferred, "resolveLegacyLaunchAtLogin") == 0,
                {"disabled": checkbox.is_disabled(), "ariaChecked": checkbox.get_attribute("aria-checked"),
                 "resolveMutationCount": deferred["resolveMutationCount"]})
            report["scenarios"]["deferLegacy"] = deferred

        with general_page(context, ready, "legacy", report["console"], report["network"]) as page:
            wait_legacy(page)
            page.get_by_role("button", name="迁移到新机制", exact=True).click()
            wait_ready_checkbox(page, True)
            migrated = preview_snapshot(page)
            assert_record(report, "legacy-migrate-enables-modern-state",
                migrated["legacyPresent"] is False and migrated["modernEnabled"] is True
                and migrated["resolveMutationCount"] == 1,
                {"legacyPresent": migrated["legacyPresent"], "modernEnabled": migrated["modernEnabled"],
                 "resolveMutationCount": migrated["resolveMutationCount"]})
            capture_owned_screenshot(page, ROOT, ready, "legacy-migrated-ready.png")
            report["screenshots"].append("legacy-migrated-ready.png")
            report["scenarios"]["migrateLegacy"] = migrated

        with general_page(context, ready, "coexisting", report["console"], report["network"]) as page:
            wait_legacy(page)
            page.get_by_role("button", name="关闭旧启动项", exact=True).click()
            wait_ready_checkbox(page, False)
            turned_off = preview_snapshot(page)
            assert_record(report, "coexisting-turn-off-disables-modern-state",
                turned_off["legacyPresent"] is False and turned_off["modernEnabled"] is False
                and turned_off["resolveMutationCount"] == 1,
                {"legacyPresent": turned_off["legacyPresent"], "modernEnabled": turned_off["modernEnabled"],
                 "resolveMutationCount": turned_off["resolveMutationCount"]})
            report["scenarios"]["coexistingTurnOff"] = turned_off

        with general_page(context, ready, "normal", report["console"], report["network"]) as page:
            wait_ready_checkbox(page, False)
            initial = preview_snapshot(page)
            assert_record(report, "normal-ready-uses-cached-launch-state",
                count(initial, "readLaunchAtLogin") == 0,
                {"readLaunchAtLogin": count(initial, "readLaunchAtLogin")})
            page.evaluate("() => window.__ATOOLS_SETTINGS_LOGIN_PREVIEW__.externalChange({enabled:true})")
            _, checkbox = login_row(page)
            login_row(page)[0].locator("label.toggle").click()
            page.get_by_role("button", name="重新读取", exact=True).wait_for(state="visible", timeout=PAGE_TIMEOUT_MS)
            _, conflicted_checkbox = login_row(page)
            conflict_snapshot = preview_snapshot(page)
            assert_record(report, "stale-normal-write-rejected-without-mutation",
                conflicted_checkbox.is_disabled()
                and conflicted_checkbox.get_attribute("aria-checked") == "mixed"
                and count(conflict_snapshot, "setLaunchAtLogin") == 1
                and conflict_snapshot["setMutationCount"] == 0,
                {"disabled": conflicted_checkbox.is_disabled(),
                 "setCalls": count(conflict_snapshot, "setLaunchAtLogin"),
                 "setMutationCount": conflict_snapshot["setMutationCount"]})
            capture_owned_screenshot(page, ROOT, ready, "normal-cas-conflict.png")
            report["screenshots"].append("normal-cas-conflict.png")
            page.get_by_role("button", name="重新读取", exact=True).click()
            page.wait_for_function(
                "() => window.__ATOOLS_SETTINGS_LOGIN_PREVIEW__?.snapshot?.().operationCounts?.readLaunchAtLogin === 1",
                timeout=PAGE_TIMEOUT_MS,
            )
            wait_ready_checkbox(page, True)
            reread = preview_snapshot(page)
            assert_record(report, "explicit-reread-restores-current-modern-state",
                count(reread, "readLaunchAtLogin") == 1 and reread["modernEnabled"] is True,
                {"readLaunchAtLogin": count(reread, "readLaunchAtLogin"),
                 "modernEnabled": reread["modernEnabled"]})
            capture_owned_screenshot(page, ROOT, ready, "normal-after-explicit-reread.png")
            report["screenshots"].append("normal-after-explicit-reread.png")
            report["scenarios"]["normalCasAndReread"] = {
                "initial": initial, "conflict": conflict_snapshot, "afterReread": reread,
            }

        with general_page(context, ready, "legacy", report["console"], report["network"]) as page:
            wait_legacy(page)
            page.evaluate("() => window.__ATOOLS_SETTINGS_LOGIN_PREVIEW__.externalChange({revisionOnly:true})")
            page.get_by_role("button", name="迁移到新机制", exact=True).click()
            page.get_by_role("button", name="重新读取", exact=True).wait_for(state="visible", timeout=PAGE_TIMEOUT_MS)
            stale = preview_snapshot(page)
            assert_record(report, "stale-legacy-revision-rejected-without-mutation",
                count(stale, "resolveLegacyLaunchAtLogin") == 1 and stale["resolveMutationCount"] == 0,
                {"resolveCalls": count(stale, "resolveLegacyLaunchAtLogin"),
                 "resolveMutationCount": stale["resolveMutationCount"]})
            page.get_by_role("button", name="重新读取", exact=True).click()
            page.get_by_role("button", name="暂不处理", exact=True).wait_for(state="visible", timeout=PAGE_TIMEOUT_MS)
            refreshed = preview_snapshot(page)
            assert_record(report, "legacy-refresh-rereads-and-reinspects",
                count(refreshed, "readLaunchAtLogin") == 2
                and count(refreshed, "inspectLegacyLaunchAtLogin") == 2
                and refreshed["resolveMutationCount"] == 0,
                {"reads": count(refreshed, "readLaunchAtLogin"),
                 "inspections": count(refreshed, "inspectLegacyLaunchAtLogin"),
                 "resolveMutationCount": refreshed["resolveMutationCount"]})
            page.get_by_role("button", name="迁移到新机制", exact=True).click()
            wait_ready_checkbox(page, True)
            recovered = preview_snapshot(page)
            assert_record(report, "refreshed-legacy-choice-can-be-explicitly-committed",
                recovered["resolveMutationCount"] == 1 and recovered["modernEnabled"] is True,
                {"resolveMutationCount": recovered["resolveMutationCount"],
                 "modernEnabled": recovered["modernEnabled"]})
            report["scenarios"]["staleLegacyRevision"] = {
                "stale": stale, "refreshed": refreshed, "recovered": recovered,
            }

        if report["console"]["pageErrors"] or any(item["type"] == "error" for item in report["console"]["messages"]):
            assert_record(report, "no-browser-console-or-page-errors", False,
                {"console": report["console"]})
        else:
            assert_record(report, "no-browser-console-or-page-errors", True)
        assert_record(report, "no-external-network-attempts", not report["network"]["externalAttempts"],
            {"externalAttempts": report["network"]["externalAttempts"]})

        context.close()
        browser.close()


def write_report(path: Path, report: dict) -> None:
    report["completeProductAcceptance"] = False
    report["nativeOS"] = False
    checks = report.get("checks", [])
    report["browserSlicePassed"] = report.get("failure") is None and len(checks) == EXPECTED_CHECK_COUNT \
        and all(item.get("passed") is True for item in checks) and not report.get("cleanupErrors")
    report["status"] = "passed" if report["browserSlicePassed"] else "failed"
    with path.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main() -> int:
    node = NodePreview()
    report: dict = {
        "schemaVersion": 1,
        "scope": "browser-fixture",
        "checks": [],
    }
    output_dir: Path | None = None
    failure_stage = "node-helper-start"
    try:
        ready = node.start()
        output_dir = owned_output_dir(ROOT, ready)
        report["runId"] = ready["runId"]
        report["outputDir"] = ready["outputDir"]
        report["sourceIdentity"] = ready["sourceIdentity"]
        report["staticServer"] = ready["staticServer"]
        report["bootstrapHashes"] = {
            "bootstrapSha256": ready["bootstrapSha256"],
            "fixtureBundleSha256": ready["fixtureBundleSha256"],
        }
        failure_stage = "browser-scenarios"
        run_browser(ready, report)
    except Exception as error:  # Keep partial browser facts and finish owned cleanup.
        report["failure"] = {
            "stage": failure_stage,
            "type": type(error).__name__,
            "message": str(error)[:1000],
        }
        print(json.dumps({"status": "failed", "failure": report["failure"]}, ensure_ascii=False), file=sys.stderr)
    finally:
        closed = node.stop()
        if closed is not None:
            if "sourceIdentity" in report:
                report["sourceIdentity"]["after"] = closed["sourceIdentity"]["after"]
                report["sourceIdentity"]["stable"] = closed["sourceIdentity"]["stable"]
            report["staticServerAfter"] = closed["staticServer"]
            report["checks"].append({
                "name": "strict-dist-and-fixture-source-stayed-stable",
                "passed": closed["sourceIdentity"]["stable"] is True,
                "facts": {"stable": closed["sourceIdentity"]["stable"]},
            })
            report["checks"].append({
                "name": "owned-loopback-server-closed-without-rejections",
                "passed": closed["staticServer"]["closed"] is True
                    and closed["staticServer"]["rejectedRequests"] == 0
                    and closed["staticServer"]["requestCount"] > 0,
                "facts": closed["staticServer"],
            })
        else:
            report.setdefault("cleanupErrors", []).append("node-server-closed-record-missing")
            report["checks"].append({
                "name": "owned-loopback-server-closed-without-rejections",
                "passed": False,
                "facts": {"closedRecord": False},
            })
        if node.process.returncode != 0:
            report.setdefault("cleanupErrors", []).append(f"node-helper-exit-{node.process.returncode}")
        if node.stderr_lines:
            report["nodeStderr"] = "\n".join(node.stderr_lines)[:2000]
        if node.stderr_truncated:
            report["nodeStderrTruncated"] = True
        if output_dir is not None:
            try:
                validated_dir = owned_output_dir(ROOT, ready)
                write_report(validated_dir / "browser-report.json", report)
            except FileExistsError:
                print("Refusing to overwrite an existing browser report", file=sys.stderr)
                return 2
    return 0 if report.get("browserSlicePassed") is True and report.get("sourceIdentity", {}).get("stable") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
