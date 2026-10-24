import argparse
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import platform
import shutil
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
DEVELOPMENT = ("typescript", "oxlint", "@types/bun")


def synthetic_source(source):
    for name in release.REQUIRED:
        path = source / name.removeprefix("app/")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic package file")
        if name.removeprefix("app/") in release.PROVIDER_EXECUTABLES.values():
            path.chmod(0o755)
    manifest = {"dependencies": {"@openai/codex": "1.0.0", "media": "1.0.0"}, "devDependencies": {name: "1.0.0" for name in DEVELOPMENT}}
    (source / "package.json").write_text(json.dumps(manifest))


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

    def test_fresh_install_does_not_request_absent_unit_names(self):
        specification = importlib.util.spec_from_file_location("installer", pathlib.Path(sys.argv[1]).with_name("install.py"))
        installer = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(installer)
        calls = []
        def systemctl(arguments):
            calls.append(arguments)
            if arguments[1] == "list-unit-files" and len(arguments) > 4:
                raise ValueError("Required command failed: /usr/bin/systemctl")
            return b""
        installer.release.command = systemctl
        installer.stop_for_install()
        self.assertEqual([arguments[1] for arguments in calls], ["list-units", "list-unit-files", "list-units"])

    def test_update_stops_only_installed_exact_unit_names(self):
        specification = importlib.util.spec_from_file_location("installer", pathlib.Path(sys.argv[1]).with_name("install.py"))
        installer = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(installer)
        calls = []
        def systemctl(arguments):
            calls.append(arguments)
            if arguments[1] == "list-unit-files":
                return b"unrelated.service enabled\npaws-runner.service disabled\npaws-runner-broker.socket enabled\npaws-runner-broker.service.backup enabled\n"
            return b""
        installer.release.command = systemctl
        installer.stop_for_install()
        self.assertEqual([arguments for arguments in calls if arguments[1] == "stop"], [["/usr/bin/systemctl", "stop", "--", "paws-runner.service", "paws-runner-broker.socket"]])
        self.assertEqual(calls[-1][1], "list-units")

    def test_unit_enumeration_failure_does_not_stop_services(self):
        specification = importlib.util.spec_from_file_location("installer", pathlib.Path(sys.argv[1]).with_name("install.py"))
        installer = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(installer)
        calls = []
        def systemctl(arguments):
            calls.append(arguments)
            if arguments[1] == "list-unit-files":
                raise ValueError("Required command failed: /usr/bin/systemctl")
            return b""
        installer.release.command = systemctl
        with self.assertRaisesRegex(ValueError, "Required command failed"):
            installer.stop_for_install()
        self.assertFalse(any(arguments[1] == "stop" for arguments in calls))

    def test_packaged_launcher_targets_are_validated_and_archived(self):
        specification = importlib.util.spec_from_file_location("packager", pathlib.Path(sys.argv[1]).with_name("package.py"))
        packager = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(packager)
        for index, target in enumerate(("adapter/dist/cli.js", "adapter/.hidden/cli.js", "adapter/dist/cli!.js")):
            with self.subTest(target=target):
                source = self.root / ("source-" + str(index))
                synthetic_source(source)
                executable = source / "node_modules" / target
                executable.parent.mkdir(parents=True, exist_ok=True)
                executable.write_bytes(b"#!/usr/bin/env node\n")
                launcher = source / "node_modules/.bin/claude-agent-acp"
                launcher.unlink()
                launcher.symlink_to(executable)
                runtime = self.root / ("bun-" + str(index))
                runtime.write_bytes(b"synthetic Bun runtime")
                output = self.root / ("package-" + str(index))
                arguments = argparse.Namespace(source=source, bun=runtime, version="1.2.3", platform={"x86_64":"linux-x64","aarch64":"linux-arm64"}[platform.machine()], output=output, mise=None)
                with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.2\n")), mock.patch.object(packager, "install_production", return_value=source / "node_modules"), mock.patch.object(packager.release, "download_mise", return_value=b"\x7fELFsynthetic-mise"):
                    if index == 0:
                        packager.pack(arguments)
                        members = release.inspect_archive(output / "artifact.tar")
                        self.assertIn("app/node_modules/" + target, members)
                        self.assertEqual(members["bin/paws-runner"].mode, 0o755)
                        self.assertEqual(members["bin/mise"].mode, 0o755)
                        with tarfile.open(output / "artifact.tar") as archive:
                            self.assertEqual(archive.extractfile("bin/paws-runner").read(), release.RUNNER_LAUNCHER)
                            for provider in ("claude", "codex"):
                                launcher = archive.extractfile("app/node_modules/.bin/" + provider).read().decode()
                                self.assertIn("'/opt/paws-runner/current/node_modules/", launcher)
                                self.assertNotIn("/usr/bin/node", launcher)
                                self.assertEqual(members["app/node_modules/.bin/" + provider].mode, 0o755)
                            codex = archive.extractfile("app/node_modules/.bin/codex").read().decode()
                            self.assertIn("exec /opt/paws-runner/bin/bun --no-env-file '", codex)
                            adapter = archive.extractfile("app/node_modules/.bin/claude-agent-acp").read().decode()
                            self.assertIn("exec /opt/paws-runner/bin/bun --no-env-file '", adapter)
                    else:
                        with self.assertRaises(ValueError):
                            packager.pack(arguments)

    def test_dependency_files_with_unsafe_names_are_left_out(self):
        specification = importlib.util.spec_from_file_location("packager", pathlib.Path(sys.argv[1]).with_name("package.py"))
        packager = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(packager)
        source = self.root / "source-unsafe"
        synthetic_source(source)
        fixture = source / "node_modules/media/test/fixtures/av01,aac.avi"
        fixture.parent.mkdir(parents=True, exist_ok=True)
        fixture.write_bytes(b"fixture")
        (source / "node_modules/media/odd dir").mkdir()
        (source / "node_modules/media/odd dir/file.js").write_bytes(b"fixture")
        (source / "node_modules/media/index.js").write_bytes(b"module")
        runtime = self.root / "bun-unsafe"
        runtime.write_bytes(b"synthetic Bun runtime")
        output = self.root / "package-unsafe"
        arguments = argparse.Namespace(source=source, bun=runtime, version="1.2.3", platform={"x86_64":"linux-x64","aarch64":"linux-arm64"}[platform.machine()], output=output, mise=None)
        with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.2\n")), mock.patch.object(packager, "install_production", return_value=source / "node_modules"), mock.patch.object(packager.release, "download_mise", return_value=b"\x7fELFsynthetic-mise"):
            packager.pack(arguments)
        members = release.inspect_archive(output / "artifact.tar")
        self.assertIn("app/node_modules/media/index.js", members)
        self.assertFalse(any("av01" in name or "odd" in name for name in members))
        (source / "src/bad,name.ts").write_bytes(b"source")
        with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.2\n")), mock.patch.object(packager, "install_production", return_value=source / "node_modules"), mock.patch.object(packager.release, "download_mise", return_value=b"\x7fELFsynthetic-mise"):
            with self.assertRaises(ValueError):
                packager.pack(argparse.Namespace(**{**vars(arguments), "output": self.root / "package-unsafe-src"}))

    def test_production_install_runs_the_pinned_bun_apart_from_the_checkout(self):
        specification = importlib.util.spec_from_file_location("packager", pathlib.Path(sys.argv[1]).with_name("package.py"))
        packager = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(packager)
        source = self.root / "source-install"
        synthetic_source(source)
        (source / "bun.lock").write_bytes(b"synthetic lockfile")
        workspace = self.root / "install-workspace"
        workspace.mkdir()
        calls = []
        def run(arguments, **options):
            calls.append((arguments, options))
            return SimpleNamespace(returncode=0, stderr=b"")
        with mock.patch.object(packager.subprocess, "run", side_effect=run):
            self.assertEqual(packager.install_production(pathlib.Path("/pinned/bun"), source, workspace), workspace / "node_modules")
        self.assertEqual(calls[0][0], ["/pinned/bun", "install", "--frozen-lockfile", "--production"])
        self.assertEqual(calls[0][1]["cwd"], workspace)
        self.assertNotEqual(calls[0][1]["cwd"], source)
        self.assertEqual((workspace / "package.json").read_bytes(), (source / "package.json").read_bytes())
        self.assertEqual((workspace / "bun.lock").read_bytes(), b"synthetic lockfile")
        (self.root / "install-failed").mkdir()
        with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr=b"lockfile had changes")):
            with self.assertRaisesRegex(ValueError, "Production dependency install failed: lockfile had changes"):
                packager.install_production(pathlib.Path("/pinned/bun"), source, self.root / "install-failed")

    def test_packed_dependencies_are_production_glibc_packages_only(self):
        specification = importlib.util.spec_from_file_location("packager", pathlib.Path(sys.argv[1]).with_name("package.py"))
        packager = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(packager)
        source = self.root / "source-production"
        synthetic_source(source)
        (source / "node_modules/only-in-checkout").mkdir()
        (source / "node_modules/only-in-checkout/index.js").write_bytes(b"tested checkout only")
        production = self.root / "production/node_modules"
        shutil.copytree(source / "node_modules", production, symlinks=True)
        shutil.rmtree(production / "only-in-checkout")
        arch = release.ARCHITECTURE[0]
        for name in (
            f"@anthropic-ai/claude-agent-sdk-linux-{arch}-musl/claude",
            f"@oxlint/binding-linux-{arch}-musl/package.json",
            f"lightningcss-linux-{arch}-musl/lightningcss.node",
            "media/node_modules/helper-linux-musl/index.js",
            "media/index.js",
            "typescript/bin/tsc",
            "oxlint/package.json",
            "@types/bun/index.d.ts",
        ):
            (production / name).parent.mkdir(parents=True, exist_ok=True)
            (production / name).write_bytes(b"#!/usr/bin/env node\n")
        (production / "media/package.json").write_text(json.dumps({"name": "media", "dependencies": {"left-pad": "1.0.0"}, "devDependencies": {"typescript": "1.0.0"}}))
        (production / ".bin/tsc").symlink_to("../typescript/bin/tsc")
        runtime = self.root / "bun-production"
        runtime.write_bytes(b"synthetic Bun runtime")
        arguments = argparse.Namespace(source=source, bun=runtime, version="1.2.3", platform={"x86_64":"linux-x64","aarch64":"linux-arm64"}[platform.machine()], output=self.root / "package-production", mise=None)
        def patches():
            return mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.2\n")), mock.patch.object(packager, "install_production", return_value=production), mock.patch.object(packager.release, "download_mise", return_value=b"\x7fELFsynthetic-mise")
        first, second, third = patches()
        with first, second, third:
            packager.pack(arguments)
        members = release.inspect_archive(self.root / "package-production/artifact.tar")
        self.assertLessEqual(release.REQUIRED, members.keys())
        self.assertIn("app/" + release.PROVIDER_EXECUTABLES["codex"], members)
        self.assertIn("app/node_modules/media/index.js", members)
        packages = {name for member in members if member.startswith("app/node_modules/") for name in packager.package_names(tuple(member.removeprefix("app/node_modules/").split("/")))}
        self.assertEqual({name for name in packages if name.endswith("-musl")}, set())
        self.assertEqual(packages & set(DEVELOPMENT), set())
        self.assertNotIn("app/node_modules/.bin/tsc", members)
        self.assertFalse(any("only-in-checkout" in name for name in members))
        (production / "media/package.json").write_text(json.dumps({"name": "media", "dependencies": {"typescript": "1.0.0"}}))
        first, second, third = patches()
        with first, second, third:
            with self.assertRaisesRegex(ValueError, "needs a development dependency: typescript"):
                packager.pack(argparse.Namespace(**{**vars(arguments), "output": self.root / "package-production-hard"}))

    def test_missing_bundled_provider_targets_reject_packaging(self):
        specification = importlib.util.spec_from_file_location("packager", pathlib.Path(sys.argv[1]).with_name("package.py"))
        packager = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(packager)
        for index, missing in enumerate(("node_modules/@openai/codex/bin/codex.js", *release.PROVIDER_EXECUTABLES.values(), release.CODEX_PLATFORM_PACKAGE)):
            with self.subTest(missing=missing):
                source = self.root / ("missing-provider-" + str(index))
                synthetic_source(source)
                (source / missing).unlink()
                runtime = self.root / ("missing-provider-bun-" + str(index))
                runtime.write_bytes(b"synthetic Bun runtime")
                arguments = argparse.Namespace(source=source, bun=runtime, version="1.2.3", platform={"x86_64":"linux-x64","aarch64":"linux-arm64"}[platform.machine()], output=self.root / ("missing-provider-package-" + str(index)), mise=None)
                with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.2\n")), mock.patch.object(packager, "install_production", return_value=source / "node_modules"):
                    with self.assertRaises(FileNotFoundError):
                        packager.pack(arguments)

    def test_archive_missing_a_bundled_provider_target_is_rejected(self):
        for missing in (name for name in release.REQUIRED if name.endswith(("/claude", "/codex", "/codex.js"))):
            with self.subTest(missing=missing):
                with tarfile.open(self.artifact, "w") as archive:
                    for name in release.REQUIRED - {missing}:
                        member = tarfile.TarInfo(name)
                        member.mode = 0o644
                        archive.addfile(member, io.BytesIO())
                with self.assertRaisesRegex(ValueError, "missing required"):
                    release.inspect_archive(self.artifact)

    def test_nonexecutable_bundled_provider_target_is_rejected(self):
        providers = {"app/" + target for target in release.PROVIDER_EXECUTABLES.values()} | {"app/node_modules/.bin/claude", "app/node_modules/.bin/codex"}
        for target in providers:
            with self.subTest(target=target):
                with tarfile.open(self.artifact, "w") as archive:
                    for name in release.REQUIRED:
                        member = tarfile.TarInfo(name)
                        member.mode = 0o644 if name == target else 0o755
                        archive.addfile(member, io.BytesIO())
                with self.assertRaisesRegex(ValueError, "must be executable"):
                    release.inspect_archive(self.artifact)

    def test_mise_is_pinned_for_both_architectures(self):
        self.assertRegex(release.MISE_VERSION, r"\A[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,4}\Z")
        self.assertEqual(set(release.MISE_SHA256), {"linux-x64", "linux-arm64"})
        for platform_name, digest in release.MISE_SHA256.items():
            self.assertRegex(digest, r"\A[0-9a-f]{64}\Z")
            self.assertEqual(release.mise_url(platform_name), f"https://github.com/jdx/mise/releases/download/v{release.MISE_VERSION}/mise-v{release.MISE_VERSION}-{platform_name}")
        with self.assertRaises(ValueError):
            release.mise_url("linux-other")

    def test_mise_with_a_wrong_checksum_fails_the_download(self):
        class Response(io.BytesIO):
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return False
        requested = []
        def opener(url, timeout):
            requested.append(url)
            return Response(b"not the pinned mise")
        for platform_name in ("linux-x64", "linux-arm64"):
            with self.subTest(platform=platform_name):
                with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                    release.download_mise(platform_name, opener)
        self.assertEqual(requested, [release.mise_url("linux-x64"), release.mise_url("linux-arm64")])

    def test_mise_with_a_wrong_checksum_fails_the_package_build(self):
        specification = importlib.util.spec_from_file_location("packager", pathlib.Path(sys.argv[1]).with_name("package.py"))
        packager = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(packager)
        source = self.root / "source-mise"
        synthetic_source(source)
        runtime = self.root / "bun-mise"
        runtime.write_bytes(b"synthetic Bun runtime")
        mise = self.root / "mise-tampered"
        mise.write_bytes(b"\x7fELFtampered mise")
        arguments = argparse.Namespace(source=source, bun=runtime, version="1.2.3", platform={"x86_64":"linux-x64","aarch64":"linux-arm64"}[platform.machine()], output=self.root / "package-mise", mise=mise)
        with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.2\n")), mock.patch.object(packager, "install_production", return_value=source / "node_modules"):
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                packager.pack(arguments)
        self.assertFalse((self.root / "package-mise/artifact.tar").exists())

    def test_nonexecutable_bundled_mise_is_rejected(self):
        with tarfile.open(self.artifact, "w") as archive:
            for name in release.REQUIRED:
                member = tarfile.TarInfo(name)
                member.mode = 0o644 if name == "bin/mise" else 0o755
                archive.addfile(member, io.BytesIO())
        with self.assertRaisesRegex(ValueError, "mise must be executable"):
            release.inspect_archive(self.artifact)

    def test_nonexecutable_runner_launcher_is_rejected(self):
        with tarfile.open(self.artifact, "w") as archive:
            for name in release.REQUIRED:
                member = tarfile.TarInfo(name)
                member.mode = 0o644 if name == "bin/paws-runner" else 0o755
                archive.addfile(member, io.BytesIO())
        with self.assertRaisesRegex(ValueError, "launcher must be executable"):
            release.inspect_archive(self.artifact)

    def test_runner_launcher_runs_the_runner_entry_on_the_bundled_bun(self):
        self.assertEqual(release.RUNNER_LAUNCHER, b'#!/bin/sh\nexec /opt/paws-runner/bin/bun --no-env-file --config=/dev/null /opt/paws-runner/current/src/runner-cli/main.ts "$@"\n')
        self.assertIn("app/src/runner-cli/main.ts", release.REQUIRED)
        root = self.root / "launcher"
        (root / "bin").mkdir(parents=True)
        bun = root / "bin/bun"
        bun.write_text('#!/bin/sh\nfor argument in "$@"; do printf "%s\\n" "$argument"; done\n')
        bun.chmod(0o755)
        launcher = root / "bin/paws-runner"
        launcher.write_bytes(release.RUNNER_LAUNCHER.replace(b"/opt/paws-runner/bin/bun", str(bun).encode()))
        launcher.chmod(0o755)
        completed = subprocess.run([str(launcher), "runner", "worker", "--execution-id", "it's spaced"], env=release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=10)
        self.assertEqual(completed.stdout.decode().splitlines(), ["--no-env-file", "--config=/dev/null", "/opt/paws-runner/current/src/runner-cli/main.ts", "runner", "worker", "--execution-id", "it's spaced"])

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
                member.mode = 0o755 if name in release.BINARIES or name.removeprefix("app/") in release.PROVIDER_EXECUTABLES.values() or name in ("app/node_modules/.bin/claude", "app/node_modules/.bin/codex") else 0o644
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
