from __future__ import annotations

import hashlib
import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "probe-ztools-head-compatibility.py"
SPEC = importlib.util.spec_from_file_location("head_probe", SCRIPT)
probe = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(probe)


def blob_oid(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def archive_with(*members: tarfile.TarInfo, payloads: dict[str, bytes] | None = None) -> io.BytesIO:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for member in members:
            if member.isfile():
                archive.addfile(member, io.BytesIO((payloads or {})[member.name]))
            else:
                archive.addfile(member)
    output.seek(0)
    return output


def directory(name: str) -> tarfile.TarInfo:
    item = tarfile.TarInfo(name)
    item.type = tarfile.DIRTYPE
    return item


def regular(name: str, body: bytes) -> tarfile.TarInfo:
    item = tarfile.TarInfo(name)
    item.type = tarfile.REGTYPE
    item.mode = 0o644
    item.size = len(body)
    return item


def archive_directory_set(expected_dirs: dict, blobs: dict, extra: tuple[str, ...] = ()) -> dict:
    directories = {"plugins": {"kind": "tree", "mode": "040000"}}
    for name, row in expected_dirs.items():
        directories[f"plugins/{name}"] = row
    for blob_path in blobs:
        parts = blob_path.split("/")
        for end in range(2, len(parts)):
            parent = "/".join(parts[:end])
            directories.setdefault(parent, {"kind": "tree", "mode": "040000"})
    for path in extra:
        directories[path] = {"kind": "tree", "mode": "040000"}
    return directories


class InventoryValidationTests(unittest.TestCase):
    def inventory(self):
        rows = []
        direct = []
        for index in range(153):
            name = f"plugin-{index:03}"
            if index < 72:
                root = f"plugins/{name}/plugin.json"
                public = f"plugins/{name}/public/plugin.json" if index < 5 else None
                classification = "main_manifest"
            elif index < 147:
                root = None
                public = f"plugins/{name}/public/plugin.json"
                classification = "source_public_only"
            else:
                root = public = None
                classification = "incomplete_top_level_manifest"
            rows.append({
                "pluginDirectory": name,
                "headClassification": classification,
                "headRootManifest": root,
                "headPublicManifest": public,
                "hasBothRootAndPublic": root is not None and public is not None,
            })
            for path, kind in ((root, "root"), (public, "public")):
                if path:
                    direct.append({"path": path, "class": kind, "head": {"bytes": 1, "sha256": "a" * 64}})
        return {
            "schemaVersion": 3,
            "repository": {
                "head": probe.EXPECTED_HEAD,
                "objectFormat": "sha1",
                "headStableThroughScan": True,
                "headRecheckedAtEnd": probe.EXPECTED_HEAD,
            },
            "counts": {
                "upstreamTopLevelPluginDirectoriesAtHead": 153,
                "mainManifestRootPluginJson": 72,
                "sourcePublicManifestOnly": 75,
                "noTopLevelMainOrPublicManifest": 6,
                "rootAndPublicBoth": 5,
            },
            "upstreamDirectories": rows,
            "directManifestEntries": direct,
        }

    def test_accepts_pinned_153_directory_denominator_and_manifest_counts(self):
        encoded = probe.json.dumps(self.inventory()).encode()
        checked = probe.checked_inventory(encoded)
        self.assertEqual(len(checked["upstreamDirectories"]), 153)

    def test_rejects_mutated_denominator_or_dupe_manifest_pin(self):
        inventory = self.inventory()
        inventory["counts"]["rootAndPublicBoth"] = 4
        with self.assertRaises(probe.AuditError):
            probe.checked_inventory(probe.json.dumps(inventory).encode())
        inventory = self.inventory()
        inventory["directManifestEntries"][1] = inventory["directManifestEntries"][0]
        with self.assertRaises(probe.AuditError):
            probe.checked_inventory(probe.json.dumps(inventory).encode())

    def test_run_rejects_valid_shaped_but_unpinned_inventory_before_git_or_archive(self):
        value = self.inventory()
        # Change one manifest digest while keeping the complete schema valid.
        value["directManifestEntries"][0]["head"]["sha256"] = "b" * 64
        raw = probe.json.dumps(value).encode()
        probe.checked_inventory(raw)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            repo = root / "repo"
            (repo / "plugins").mkdir(parents=True)
            output_parent = root / "outputs"
            output_parent.mkdir()
            inventory_file = root / "inventory.json"
            inventory_file.write_bytes(raw)
            args = SimpleNamespace(
                repo=str(repo), inventory=str(inventory_file), classifier=str(root / "classifier"),
                out=str(output_parent / "fresh-output"),
            )
            with mock.patch.object(probe, "git_bytes") as git_bytes, mock.patch.object(probe.subprocess, "Popen") as popen:
                with self.assertRaisesRegex(probe.AuditError, "inventory_sha256_mismatch"):
                    probe.run(args)
                git_bytes.assert_not_called()
                popen.assert_not_called()

    def test_recursive_git_tree_records_gitlinks_and_blob_sizes(self):
        oid = "a" * 40
        listing = (
            f"040000 tree {oid} -\tplugins\0"
            f"040000 tree {oid}\tplugins/foo\0"
            f"160000 commit {oid}\tplugins/submodule\0"
            f"100644 blob {oid} 7\tplugins/foo/main.js\0"
        ).encode()
        directories, blobs, archive_directories = probe.parse_ls_tree(listing)
        self.assertEqual(directories["submodule"]["kind"], "commit")
        self.assertEqual(blobs["plugins/foo/main.js"]["size"], 7)
        self.assertEqual(archive_directories["plugins/submodule"]["kind"], "commit")
        self.assertEqual(set(archive_directories), {"plugins", "plugins/foo", "plugins/submodule"})

    def test_nul_protocol_preserves_cjk_spaces_tabs_and_newlines(self):
        oid = "a" * 40
        plugin_name = "图像 工具\t第二行\n"
        directories = probe.parse_ls_tree_directories(
            f"040000 tree {oid}\t{plugin_name}\0".encode()
        )
        self.assertEqual(directories[plugin_name], {"oid": oid, "kind": "tree", "mode": "040000"})
        file_path = f"plugins/{plugin_name}/资源 文件\t名称\n.png"
        recursive = (
            f"040000 tree {oid} -\tplugins\0"
            f"040000 tree {oid}\tplugins/{plugin_name}\0"
            f"100644 blob {oid} 7\t{file_path}\0"
        ).encode()
        parsed_directories, blobs, archive_directories = probe.parse_ls_tree(recursive)
        self.assertEqual(parsed_directories[plugin_name]["kind"], "tree")
        self.assertEqual(blobs[file_path], {"oid": oid, "size": 7, "mode": "100644", "owner": plugin_name})
        self.assertIn(f"plugins/{plugin_name}", archive_directories)

    def test_exact_head_entry_budget_includes_all_trees_blobs_gitlinks_and_root(self):
        oid = "a" * 40
        listing = (
            f"040000 tree {oid} -\tplugins\0"
            f"040000 tree {oid}\tplugins/foo\0"
            f"040000 tree {oid}\tplugins/foo/nested\0"
            f"160000 commit {oid}\tplugins/foo/nested/submodule\0"
            f"100644 blob {oid} 1\tplugins/foo/nested/a\0"
        ).encode()
        _, blobs, archive_directories = probe.parse_ls_tree(listing)
        self.assertEqual(len(archive_directories), 4)  # root + two trees + gitlink
        self.assertEqual(probe.head_archive_member_budget(archive_directories, blobs), 5)

    def test_tree_listing_requires_parent_directories_and_rejects_tree_blob_alias(self):
        oid = "a" * 40
        with self.assertRaisesRegex(probe.AuditError, "tree_directory_parent_missing"):
            probe.parse_ls_tree((
                f"040000 tree {oid} -\tplugins\0"
                f"100644 blob {oid} 1\tplugins/foo/nested/a\0"
            ).encode())
        with self.assertRaisesRegex(probe.AuditError, "tree_entry_path_duplicate"):
            probe.parse_ls_tree((
                f"040000 tree {oid} -\tplugins\0"
                f"040000 tree {oid}\tplugins/foo\0"
                f"100644 blob {oid} 1\tplugins/foo\0"
            ).encode())

    def test_archive_member_budget_has_a_separate_absolute_hard_limit(self):
        with mock.patch.dict(probe.head_archive_member_budget.__globals__, {"MAX_ARCHIVE_MEMBERS_HARD": 1}):
            with self.assertRaisesRegex(probe.AuditError, "archive_member_budget_over_hard_limit"):
                probe.head_archive_member_budget(
                    {"plugins": {"kind": "tree"}, "plugins/foo": {"kind": "tree"}},
                    {},
                )

    def test_nul_tree_protocol_rejects_traversal_and_malformed_framing(self):
        oid = "a" * 40
        for path in ("plugins/foo/../escape", "plugins/foo//empty", "plugins/../escape"):
            listing = f"100644 blob {oid} 1\t{path}\0".encode()
            with self.subTest(path=path), self.assertRaisesRegex(probe.AuditError, "tree_listing_path_invalid"):
                probe.parse_ls_tree(listing)
        with self.assertRaisesRegex(probe.AuditError, "tree_listing_malformed"):
            probe.parse_ls_tree(f"100644 blob {oid} 1\tplugins/foo/a".encode())
        with self.assertRaisesRegex(probe.AuditError, "tree_listing_invalid_utf8"):
            probe.parse_ls_tree(b"100644 blob " + oid.encode() + b" 1\tplugins/foo/\xff\0")

    def test_direct_tree_rejects_nested_or_duplicate_names(self):
        oid = "a" * 40
        with self.assertRaisesRegex(probe.AuditError, "tree_listing_path_invalid"):
            probe.parse_ls_tree_directories(f"040000 tree {oid}\tfoo/bar\0".encode())
        with self.assertRaisesRegex(probe.AuditError, "tree_directory_duplicate"):
            probe.parse_ls_tree_directories((
                f"040000 tree {oid}\tfoo\0"
                f"040000 tree {oid}\tfoo\0"
            ).encode())


class ClassifierOutputBindingTests(unittest.TestCase):
    def rows_and_records(self):
        rows = []
        records = []
        for index in range(153):
            name = f"plugin-{index:03}"
            row = {
                "pluginDirectory": name,
                "treeOid": f"{index:040x}",
                "headClassification": "incomplete_top_level_manifest",
                "headRootManifest": None,
                "headPublicManifest": None,
                "manifestPins": {},
                "snapshotState": "materialized",
                "snapshotIssues": [],
            }
            rows.append(row)
            records.append({**row, "analysisState": "no_direct_manifest", "packageReadiness": None, "classifier": None, "readinessDiagnosticCodes": []})
        return rows, records

    def test_requires_source_identity_and_explicit_no_manifest_state(self):
        rows, records = self.rows_and_records()
        value = {
            "schemaVersion": 2,
            "head": probe.EXPECTED_HEAD,
            "pluginsTreeOid": "a" * 40,
            "counts": {"analysisStates": {"no_direct_manifest": 153}, "tiers": {
                "tier1_direct_web_view": 0,
                "tier2_quickjs_or_node_sidecar": 0,
                "tier3_requires_build_or_native_addon": 0,
            }, "readinessDiagnosticCodes": {}},
            "records": records,
        }
        probe.validate_classifier_output(value, rows, probe.EXPECTED_HEAD, "a" * 40)
        altered = {**value, "records": [*records]}
        altered["records"][0] = {**records[0], "treeOid": "b" * 40}
        with self.assertRaises(probe.AuditError):
            probe.validate_classifier_output(altered, rows, probe.EXPECTED_HEAD, "a" * 40)

    def test_requires_sorted_allowlisted_diagnostics_and_exact_aggregate_counts(self):
        rows, records = self.rows_and_records()
        manifest = "plugins/plugin-000/plugin.json"
        rows[0] = {
            **rows[0],
            "headClassification": "main_manifest",
            "headRootManifest": manifest,
            "manifestPins": {"root": {"path": manifest, "bytes": 1, "sha256": "a" * 64}},
        }
        records[0] = {
            **rows[0],
            "analysisState": "classified",
            "packageReadiness": "incomplete",
            "classifier": {"tier": "tier3_requires_build_or_native_addon"},
            "readinessDiagnosticCodes": ["missing_main", "missing_script"],
        }
        value = {
            "schemaVersion": 2,
            "head": probe.EXPECTED_HEAD,
            "pluginsTreeOid": "a" * 40,
            "counts": {
                "analysisStates": {"classified": 1, "no_direct_manifest": 152},
                "tiers": {
                    "tier1_direct_web_view": 0,
                    "tier2_quickjs_or_node_sidecar": 0,
                    "tier3_requires_build_or_native_addon": 1,
                },
                "readinessDiagnosticCodes": {"missing_main": 1, "missing_script": 1},
            },
            "records": records,
        }
        probe.validate_classifier_output(value, rows, probe.EXPECTED_HEAD, "a" * 40)
        altered = {**value, "counts": {**value["counts"], "readinessDiagnosticCodes": {"missing_main": 2, "missing_script": 1}}}
        with self.assertRaisesRegex(probe.AuditError, "classifier_output_count_values_mismatch"):
            probe.validate_classifier_output(altered, rows, probe.EXPECTED_HEAD, "a" * 40)


class SafeMaterializationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name) / "plugins"
        self.root.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_regular_file_is_materialized_only_after_git_blob_hash_match(self):
        body = b"pinned source"
        members = (directory("plugins/"), directory("plugins/foo/"), regular("plugins/foo/main.js", body))
        result = probe.materialize_archive(
            archive_with(*members, payloads={"plugins/foo/main.js": body}),
            self.root,
            {"foo": {"kind": "tree"}},
            {"plugins/foo/main.js": {"owner": "foo", "size": len(body), "oid": blob_oid(body), "mode": "100644"}},
            expected_archive_directories=archive_directory_set(
                {"foo": {"kind": "tree"}}, {"plugins/foo/main.js": {}}
            ),
        )
        self.assertEqual((self.root / "foo/main.js").read_bytes(), body)
        self.assertEqual(result["incompatible"], {})
        self.assertEqual(result["memberCount"], result["headAllowedMemberCount"])
        self.assertEqual(result["headAllowedMemberCount"], 3)
        self.assertEqual(result["excludedGitlinks"], [])

    def test_manifest_sha_mismatch_is_an_explicit_row_incompatibility(self):
        body = b"manifest bytes"
        result = probe.materialize_archive(
            archive_with(directory("plugins/"), directory("plugins/foo/"), regular("plugins/foo/plugin.json", body), payloads={"plugins/foo/plugin.json": body}),
            self.root,
            {"foo": {"kind": "tree"}},
            {"plugins/foo/plugin.json": {"owner": "foo", "size": len(body), "oid": blob_oid(body), "mode": "100644"}},
            {"plugins/foo/plugin.json": {"owner": "foo", "bytes": len(body), "sha256": "0" * 64}},
            archive_directory_set(
                {"foo": {"kind": "tree"}}, {"plugins/foo/plugin.json": {}}
            ),
        )
        self.assertEqual(result["incompatible"]["foo"], ["archive_content_mismatch"])

    def test_symlink_is_explicitly_incompatible_and_never_created(self):
        target = "../outside"
        item = tarfile.TarInfo("plugins/foo/link")
        item.type = tarfile.SYMTYPE
        item.linkname = target
        result = probe.materialize_archive(
            archive_with(directory("plugins/"), directory("plugins/foo/"), item),
            self.root,
            {"foo": {"kind": "tree"}},
            {"plugins/foo/link": {"owner": "foo", "size": len(target), "oid": blob_oid(target.encode()), "mode": "120000"}},
            expected_archive_directories=archive_directory_set(
                {"foo": {"kind": "tree"}}, {"plugins/foo/link": {}}
            ),
        )
        self.assertEqual(result["incompatible"]["foo"], ["symlink_not_followed"])
        self.assertFalse((self.root / "foo/link").exists())

    def test_gitlink_is_not_materialized_and_is_a_row_level_state(self):
        result = probe.materialize_archive(
            archive_with(directory("plugins/")),
            self.root,
            {"nested": {"kind": "commit"}},
            {},
            expected_archive_directories=archive_directory_set({"nested": {"kind": "commit"}}, {}),
        )
        self.assertEqual(result["incompatible"]["nested"], ["gitlink_not_archived"])
        self.assertEqual(result["excludedGitlinks"], ["plugins/nested"])
        self.assertFalse((self.root / "nested").exists())

    def test_gitlink_archive_does_not_authorize_arbitrary_nested_files(self):
        blobs = {"plugins/nested/extra.js": {"owner": "nested", "size": 1, "oid": blob_oid(b"x"), "mode": "100644"}}
        with self.assertRaisesRegex(probe.AuditError, "archive_path_not_in_head_tree"):
            probe.materialize_archive(
                archive_with(directory("plugins/"), directory("plugins/nested/"), regular("plugins/nested/extra.js", b"x"), payloads={"plugins/nested/extra.js": b"x"}),
                self.root,
                {"nested": {"kind": "commit"}},
                blobs,
                expected_archive_directories=archive_directory_set({"nested": {"kind": "commit"}}, blobs),
            )

    def test_duplicate_and_traversal_archive_paths_fail_closed(self):
        one = directory("plugins/foo/")
        with self.assertRaises(probe.AuditError):
            probe.materialize_archive(
                archive_with(directory("plugins/"), one, directory("plugins/foo/")),
                self.root,
                {"foo": {"kind": "tree"}},
                {},
                archive_directory_set({"foo": {"kind": "tree"}}, {}),
            )
        with self.assertRaises(probe.AuditError):
            probe.safe_member_path("plugins/foo/../../outside")

    def test_symlink_parent_is_rejected_before_file_write(self):
        outside = pathlib.Path(self.temp.name) / "outside"
        outside.mkdir()
        (self.root / "foo").symlink_to(outside, target_is_directory=True)
        body = b"no escape"
        with self.assertRaises(probe.AuditError):
            probe.materialize_archive(
                archive_with(directory("plugins/"), directory("plugins/foo/"), regular("plugins/foo/main.js", body), payloads={"plugins/foo/main.js": body}),
                self.root,
                {"foo": {"kind": "tree"}},
                {"plugins/foo/main.js": {"owner": "foo", "size": len(body), "oid": blob_oid(body), "mode": "100644"}},
                archive_directory_set(
                    {"foo": {"kind": "tree"}}, {"plugins/foo/main.js": {}}
                ),
            )
        self.assertFalse((outside / "main.js").exists())

    def test_hardlink_and_special_entry_are_explicit_and_never_followed(self):
        hardlink = tarfile.TarInfo("plugins/foo/hard")
        hardlink.type = tarfile.LNKTYPE
        hardlink.linkname = "plugins/foo/target"
        special = tarfile.TarInfo("plugins/foo/fifo")
        special.type = tarfile.FIFOTYPE
        blobs = {
            "plugins/foo/hard": {"owner": "foo", "size": 0, "oid": blob_oid(b""), "mode": "100644"},
            "plugins/foo/fifo": {"owner": "foo", "size": 0, "oid": blob_oid(b""), "mode": "100644"},
        }
        result = probe.materialize_archive(
            archive_with(directory("plugins/"), directory("plugins/foo/"), hardlink, special),
            self.root,
            {"foo": {"kind": "tree"}},
            blobs,
            expected_archive_directories=archive_directory_set({"foo": {"kind": "tree"}}, blobs),
        )
        self.assertEqual(
            result["incompatible"]["foo"],
            ["archive_representation_unsupported", "hardlink_not_followed", "special_file_not_materialized"],
        )
        self.assertFalse((self.root / "foo/hard").exists())
        self.assertFalse((self.root / "foo/fifo").exists())

    def test_archive_directory_must_be_an_exact_head_tree_entry(self):
        with self.assertRaisesRegex(probe.AuditError, "archive_directory_not_in_head_tree"):
            probe.materialize_archive(
                archive_with(directory("plugins/"), directory("plugins/foo/"), directory("plugins/foo/extra/")),
                self.root,
                {"foo": {"kind": "tree"}},
                {},
                expected_archive_directories=archive_directory_set(
                    {"foo": {"kind": "tree"}}, {}
                ),
            )

    def test_archive_requires_exact_tree_inventory_and_respects_head_derived_budget(self):
        body = b"bounded"
        blobs = {"plugins/foo/nested/a": {"owner": "foo", "size": len(body), "oid": blob_oid(body), "mode": "100644"}}
        directories = archive_directory_set(
            {"foo": {"kind": "tree"}}, blobs, extra=("plugins/foo/nested",)
        )
        archive = archive_with(
            directory("plugins/"), directory("plugins/foo/"), directory("plugins/foo/nested/"),
            regular("plugins/foo/nested/a", body), payloads={"plugins/foo/nested/a": body},
        )
        result = probe.materialize_archive(archive, self.root, {"foo": {"kind": "tree"}}, blobs, expected_archive_directories=directories)
        self.assertEqual(result["headAllowedDirectoryCount"], 3)
        self.assertEqual(result["headAllowedBlobCount"], 1)
        self.assertEqual(result["memberCount"], 4)


if __name__ == "__main__":
    unittest.main()
