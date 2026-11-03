"""Only the two authorized, hash-pinned original-editor fixed-input fixtures.

The Swift controller owns ABC selection/restoration and the post-click handshake.
This coordinator observes the private phase file and exact temporary app geometry.
It never supplies arbitrary text, changes focus, or retries an input action.
"""
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
INSPECTOR = ROOT / "scripts/lib/native-editor-inspect.applescript"
SCRIPT = ROOT / "scripts/lib/native-editor-fixed-input.applescript"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def read_command(args, timeout=8, env=None):
    try:
        process = subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                                 timeout=timeout, env=env)
        return {"exitCode": process.returncode, "stdout": process.stdout,
                "stderr": process.stderr, "timedOut": False}
    except subprocess.TimeoutExpired:
        return {"exitCode": None, "timedOut": True}


def observed_point(text, operation, case):
    header = re.search(r"(?m)^WINDOW\|[^\n]*\|(-?\d+),(-?\d+)\|(\d+),(\d+)$", text)
    node = re.search(r"(?m)^1\|AXWindow\|[^\n]*?\|(-?\d+),(-?\d+)\|(\d+),(\d+)(?=\n|$)", text)
    if not header or not node or header.groups() != node.groups():
        raise ValueError("Owned window geometry is not consistent")
    wx, wy, ww, wh = map(int, header.groups())
    nodes = []
    for match in re.finditer(r"(?ms)^(\d+)\|(AX\w+)\|(.*?)\|(-?\d+),(-?\d+)\|(\d+),(\d+)(?=\n|$)", text):
        _, role, name, x, y, width, height = match.groups()
        nodes.append({"role": role, "name": name, "x": int(x), "y": int(y),
                      "w": int(width), "h": int(height)})
    if operation == "json-format":
        buttons = [n for n in nodes if n["role"] == "AXButton" and n["name"].startswith("重新格式化")]
        if len(buttons) != 1:
            raise ValueError("Exact original format button not observed")
        target = buttons[0]
        x, y = target["x"] + target["w"] // 2, target["y"] + target["h"] // 2
    else:
        editors = [n for n in nodes if n["role"] == "AXTextArea" and n["x"] >= wx
                   and n["y"] >= wy and n["w"] > 0 and n["h"] > 0]
        if not editors:
            raise ValueError("Original editor geometry not observed")
        if case == "local-json-editor":
            # The pinned original package places its editable input on the left.
            # Never choose its larger read-only output editor by area.
            editors = [n for n in editors if n["x"] < wx + ww // 2]
            if not editors:
                raise ValueError("Original left input editor geometry not observed")
            leftmost = min(n["x"] for n in editors)
            editors = [n for n in editors if n["x"] == leftmost]
            if len(editors) != 1:
                raise ValueError("Ambiguous original left input editor")
        target = max(editors, key=lambda n: n["w"] * n["h"])
        x = target["x"] + (min(80, target["w"] // 2) if case == "local-plain-text" else target["w"] // 2)
        y = target["y"] + (min(110, target["h"] // 2) if case == "local-plain-text" else target["h"] // 2)
    if not (wx + 10 <= x <= wx + ww - 10 and wy + 40 <= y <= wy + wh - 10):
        raise ValueError("Observed point is outside the owned window interior")
    return x, y, target, [wx, wy, ww, wh]


def main():
    arguments = sys.argv[1:]
    if len(arguments) == 3:
        case, folder, controller_report = arguments
        native_launch_mode = "direct"
    elif len(arguments) == 5 and arguments[3:4] == ["--native-launch-mode"] and arguments[4] == "launchservices":
        case, folder, controller_report = arguments[:3]
        native_launch_mode = "launchservices"
    else:
        raise ValueError("Usage: control-native-editor-input.py local-case private-output-dir controller-report.json [--native-launch-mode launchservices]")
    if case not in ("local-plain-text", "local-json-editor"):
        raise ValueError("Two registered original editor cases only")
    output = Path(folder).resolve()
    output.mkdir(mode=0o700, exist_ok=False)
    boundary = json.loads(Path(controller_report).read_text())
    controller = Path(boundary["binary"]["path"])
    if not boundary["passed"] or digest(controller) != boundary["binary"]["sha256"]:
        raise ValueError("Reviewed controller binary required")
    for name, path in (("swift", ROOT / "scripts/lib/native-editor-input-source.swift"), ("appleScript", SCRIPT)):
        if digest(path) != boundary["sourceAfter"][name]:
            raise ValueError("Controller source changed after boundary tests")
    script_hash = boundary["sourceAfter"]["appleScript"]
    inspector_hash = digest(INSPECTOR)
    if "set frontmost to" in INSPECTOR.read_text():
        raise ValueError("Inspector must be read-only")
    steps = ["plain-alpha", "plain-beta"] if case == "local-plain-text" else ["json-valid", "json-format", "json-malformed", "json-recovery"]
    record = {"schemaVersion": 2, "case": case, "nativeLaunchMode": native_launch_mode, "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "actions": [], "inspections": [], "controller": boundary["binary"], "inspectorSha256": inspector_hash,
              "scope": "Read-only owned-app geometry; exact fixed operations once each; private fresh post-click handshake; controller-owned temporary ABC/restoration. No focus intervention, clipboard or arbitrary input."}
    save(output / "input-source-before.json", read_command([str(controller), "inspect"]))
    argv = ["node", "scripts/probe-local-original-plugin-native.mjs", case, str(output / "native-result.json"), "--native-ui-input"]
    if native_launch_mode == "launchservices":
        argv.extend(["--native-launch-mode", "launchservices"])
    with (output / "native-run.log").open("x") as log:
        process = subprocess.Popen(argv, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        record["wrapperPID"] = process.pid
        try:
            app = None
            deadline = time.monotonic() + 420
            while process.poll() is None and time.monotonic() < deadline:
                for line in (output / "native-run.log").read_text().splitlines():
                    if line.startswith('{"temporaryApplication":'):
                        app = json.loads(line)["temporaryApplication"]
                        break
                if app:
                    break
                time.sleep(.25)
            if not app:
                raise ValueError("No live temporary application was observed")
            record["temporaryApplication"] = app
            print(json.dumps({"temporaryApplication": app}), flush=True)
            bundle = app["bundleId"]
            if not re.fullmatch(r"dev\.atools\.fixture\.dialog\.[0-9a-f]{32}", bundle):
                raise ValueError("Unowned application identity")
            exchange = Path(app["inputExchangeRoot"])
            env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
                   "ATOOLS_NATIVE_EDITOR_INPUT_EXCHANGE": str(exchange)}
            for ordinal, operation in enumerate(steps, 1):
                phase = operation.split("-")[1]
                ready = None
                deadline = time.monotonic() + 20
                while process.poll() is None and time.monotonic() < deadline:
                    path = exchange / "ready.json"
                    if path.is_file() and path.stat().st_size <= 4096:
                        value = json.loads(path.read_text())
                        if value.get("phase") == phase and value.get("caseId") == case and value.get("actionOrdinal") == ordinal:
                            ready = value
                            break
                    time.sleep(.1)
                if not ready:
                    raise ValueError("No current native phase; no further input dispatched")
                save(output / (operation + "-ready.json"), ready)
                if digest(INSPECTOR) != inspector_hash:
                    raise ValueError("Inspector changed")
                inspection = read_command(["/usr/bin/osascript", str(INSPECTOR), bundle])
                record["inspections"].append({"phase": phase, "exitCode": inspection["exitCode"]})
                if inspection["exitCode"] != 0:
                    raise ValueError("Owned-app read-only inspection failed")
                text = inspection["stdout"]
                pid = re.search(r"(?m)^PID\|(\d+)$", text)
                if not pid or int(pid[1]) != ready["pid"]:
                    raise ValueError("Observed PID differs from private native phase")
                x, y, target, window = observed_point(text, operation, case)
                # Do not persist the raw AX tree or names, even from this private fixed-input app.
                target = {key: target[key] for key in ("role", "x", "y", "w", "h")}
                save(output / (operation + "-inspection.json"), {"exitCode": 0, "timedOut": False,
                     "pidMatches": True, "target": target, "window": window, "rawAXRecorded": False})
                if digest(SCRIPT) != script_hash or digest(controller) != boundary["binary"]["sha256"]:
                    raise ValueError("Reviewed controller or fixed script changed before dispatch")
                action = read_command([str(controller), "execute", bundle, pid[1], operation,
                                       str(x), str(y), str(SCRIPT), script_hash], timeout=24, env=env)
                action.update({"operation": operation, "observedPointBasis": target, "window": window})
                save(output / (operation + "-control.json"), action)
                record["actions"].append(action)
                print(json.dumps({"operation": operation, "exitCode": action["exitCode"]}), flush=True)
                for name in ("request.json", "ack.json"):
                    path = exchange / name
                    if path.is_file() and path.stat().st_size <= 4096:
                        save(output / (operation + "-" + name), json.loads(path.read_text()))
                if action["exitCode"] != 0:
                    break
        except Exception as error:
            record["stoppedReason"] = str(error)
            print(json.dumps({"stoppedReason": str(error)}), flush=True)
        finally:
            try:
                process.wait(timeout=360)
                record["wrapperExitCode"] = process.returncode
            except subprocess.TimeoutExpired:
                record["wrapperStillRunning"] = True
                record["cleanupStatus"] = "Pending owned wrapper terminal state; no cleanup claimed"
    save(output / "input-source-after.json", read_command([str(controller), "inspect"]))
    record["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    record["nativeReportExists"] = (output / "native-result.json").exists()
    save(output / "orchestration.json", record)
    print(json.dumps({"folder": str(output), "actions": len(record["actions"]),
                      "nativeReportExists": record["nativeReportExists"], "wrapperExitCode": process.returncode}), flush=True)


if __name__ == "__main__":
    main()
