import argparse
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import platform
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("release", sys.argv[1])
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseVerification(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="paws-release-test-")
        self.root = pathlib.Path(self.temporary.name)
        self.private = self.root / "signing.pem"
        self.key = self.root / "release.pub"
        self.openssl("genpkey", "-algorithm", "ED25519", "-out", str(self.private))
        self.openssl("pkey", "-in", str(self.private), "-pubout", "-out", str(self.key))
        self.artifact = self.root / "artifact.tar"
        self.manifest = self.root / "manifest.json"
        self.signature = self.root / "manifest.sig"
        self.archive()
        self.sign()

    def test_active_execution_refusal_preserves_running_broker(self):
        specification = importlib.util.spec_from_file_location("installer", pathlib.Path(sys.argv[1]).with_name("install.py"))
        installer = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(installer)
        calls = []
        def systemctl(arguments):
            calls.append(arguments)
            if arguments[1] == "list-unit-files":
                return b"paws-runner.service enabled\npaws-runner-broker.socket enabled\npaws-runner-broker.service enabled\n"
            if arguments[1] == "list-units":
                return b"paws-check-witness@01K00000000000000000000000.service loaded active running\n"
            return b""
        installer.release.command = systemctl
        with self.assertRaises(ValueError):
            installer.stop_for_install()
        self.assertFalse(any(arguments[1] == "stop" for arguments in calls))

    def test_extracted_directories_remain_searchable_under_private_umask(self):
        specification = importlib.util.spec_from_file_location("installer", pathlib.Path(sys.argv[1]).with_name("install.py"))
        installer = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(installer)
        destination = self.root / "extracted"
        destination.mkdir()
        previous = os.umask(0o077)
        try:
            installer.extract_verified(self.artifact, destination)
        finally:
            os.umask(previous)
        for directory in (destination / "app", destination / "app/src", destination / "app/node_modules", destination / "app/node_modules/.bin", destination / "deploy/linux", destination / "bin"):
            self.assertEqual(directory.stat().st_mode & 0o7777, 0o755)

    def test_packaged_launcher_targets_are_validated_and_archived(self):
        specification = importlib.util.spec_from_file_location("packager", pathlib.Path(sys.argv[1]).with_name("package.py"))
        packager = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(packager)
        for index, target in enumerate(("adapter/dist/cli.js", "adapter/.hidden/cli.js", "adapter/dist/cli!.js")):
            with self.subTest(target=target):
                source = self.root / ("source-" + str(index))
                for name in release.REQUIRED:
                    path = source / name.removeprefix("app/")
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b"synthetic package file")
                executable = source / "node_modules" / target
                executable.parent.mkdir(parents=True, exist_ok=True)
                executable.write_bytes(b"#!/usr/bin/env node\n")
                launcher = source / "node_modules/.bin/claude-agent-acp"
                launcher.unlink()
                launcher.symlink_to(executable)
                runtime = self.root / ("bun-" + str(index))
                runtime.write_bytes(b"synthetic Bun runtime")
                output = self.root / ("package-" + str(index))
                arguments = argparse.Namespace(source=source, bun=runtime, version="1.2.3", platform={"x86_64":"linux-x64","aarch64":"linux-arm64"}[platform.machine()], output=output)
                with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.2\n")):
                    if index == 0:
                        packager.pack(arguments)
                        self.assertIn("app/node_modules/" + target, release.inspect_archive(output / "artifact.tar"))
                    else:
                        with self.assertRaises(ValueError):
                            packager.pack(arguments)

    def tearDown(self):
        self.temporary.cleanup()

    def openssl(self, *arguments):
        subprocess.run(["/usr/bin/openssl", *arguments], env=release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=10)

    def archive(self, extra=None):
        with tarfile.open(self.artifact, "w") as archive:
            for name in sorted(release.REQUIRED):
                member = tarfile.TarInfo(name)
                content = b"synthetic reviewed release file"
                member.size = len(content)
                member.mode = 0o755 if name == "bin/bun" else 0o644
                archive.addfile(member, io.BytesIO(content))
            if extra is not None:
                archive.addfile(extra, io.BytesIO(b"x" * extra.size) if extra.isfile() else None)

    def sign(self, changes=None):
        manifest = {"format": 1, "version": "1.2.3", "platform": {"x86_64": "linux-x64", "aarch64": "linux-arm64"}[platform.machine()], "bunVersion": "1.4.2", "artifactSha256": hashlib.sha256(self.artifact.read_bytes()).hexdigest()}
        manifest.update(changes or {})
        self.manifest.write_text(json.dumps(manifest))
        self.openssl("pkeyutl", "-sign", "-rawin", "-inkey", str(self.private), "-in", str(self.manifest), "-out", str(self.signature))

    def verify(self):
        with tempfile.TemporaryDirectory(dir=self.root) as staging:
            arguments = argparse.Namespace(manifest=self.manifest, signature=self.signature, artifact=self.artifact, release_key=self.key)
            return release.verify_release(arguments, pathlib.Path(staging))[0]

    def test_exact_signed_manifest_and_artifact_verify(self):
        self.assertEqual(self.verify()["version"], "1.2.3")
        self.assertEqual(self.verify()["bunVersion"], "1.4.2")

    def test_unsigned_changed_manifest_and_changed_artifact_fail(self):
        original = self.signature.read_bytes()
        self.signature.write_bytes(b"")
        with self.assertRaises(ValueError):
            self.verify()
        self.signature.write_bytes(original)
        self.manifest.write_bytes(self.manifest.read_bytes() + b" ")
        with self.assertRaises(ValueError):
            self.verify()
        self.sign()
        self.artifact.write_bytes(self.artifact.read_bytes() + b"tampered")
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            self.verify()

    def test_wrong_trusted_key_and_non_ed25519_key_fail(self):
        wrong = self.root / "wrong.pem"
        self.openssl("genpkey", "-algorithm", "ED25519", "-out", str(wrong))
        self.openssl("pkey", "-in", str(wrong), "-pubout", "-out", str(self.key))
        with self.assertRaises(ValueError):
            self.verify()
        self.openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", str(wrong))
        self.openssl("pkey", "-in", str(wrong), "-pubout", "-out", str(self.key))
        with self.assertRaisesRegex(ValueError, "Ed25519"):
            self.verify()

    def test_strict_fields_versions_platform_and_runtime(self):
        for changes in ({"extra": True}, {"format": True}, {"format": 2}, {"version": "01.2.3"}, {"version": "1.2.3-beta"}, {"bunVersion": "1.4.1"}, {"platform": "linux-other"}, {"artifactSha256": "not-a-digest"}):
            with self.subTest(changes=changes):
                self.sign(changes)
                with self.assertRaises(ValueError):
                    self.verify()
        other = "linux-arm64" if platform.machine() == "x86_64" else "linux-x64"
        self.sign({"platform": other})
        with self.assertRaisesRegex(ValueError, "match this Linux host"):
            self.verify()

    def test_duplicate_json_field_is_rejected_even_when_signed(self):
        content = self.manifest.read_text().replace('"format": 1', '"format": 1, "format": 1')
        self.manifest.write_text(content)
        self.openssl("pkeyutl", "-sign", "-rawin", "-inkey", str(self.private), "-in", str(self.manifest), "-out", str(self.signature))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.verify()

    def test_traversal_symlink_hardlink_hidden_and_unexpected_members_fail(self):
        for name, kind in (("../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE), ("app/src/../escape", tarfile.REGTYPE), ("app/src/link", tarfile.SYMTYPE), ("app/src/hard", tarfile.LNKTYPE), ("app/src/.env", tarfile.REGTYPE), ("etc/cron.d/paws", tarfile.REGTYPE)):
            with self.subTest(name=name):
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = "/etc/passwd" if kind != tarfile.REGTYPE else ""
                member.size = 0
                member.mode = 0o644
                self.archive(member)
                self.sign()
                with self.assertRaises(ValueError):
                    self.verify()

    def test_duplicate_member_and_unsafe_modes_fail(self):
        for name, mode in (("app/src/index.ts", 0o644), ("app/src/extra.ts", 0o4777), ("app/src/extra.ts", 0o666)):
            with self.subTest(name=name, mode=mode):
                member = tarfile.TarInfo(name)
                member.mode = mode
                self.archive(member)
                self.sign()
                with self.assertRaises(ValueError):
                    self.verify()

    def test_incomplete_archive_and_input_symlink_fail(self):
        with tarfile.open(self.artifact, "w"):
            pass
        self.sign()
        with self.assertRaisesRegex(ValueError, "missing required"):
            self.verify()
        target = self.root / "real.tar"
        self.artifact.rename(target)
        self.artifact.symlink_to(target)
        with self.assertRaises(OSError):
            self.verify()


if __name__ == "__main__":
    unittest.main(argv=sys.argv[:1], verbosity=2)
