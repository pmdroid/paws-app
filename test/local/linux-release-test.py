import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import platform
import shlex
import shutil
import stat
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from unittest import mock
from types import SimpleNamespace


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("release", sys.argv[1])
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
DEVELOPMENT = ("typescript", "oxlint", "@types/bun")


AGENT_MANIFEST = pathlib.Path(sys.argv[1]).with_name("agents.json")


def agent_pins(content):
    return {entry["package"]: entry["version"] for entry in json.loads(content)["agents"].values()}


def synthetic_source(source, agents=None):
    for name in release.REQUIRED:
        path = source / name.removeprefix("app/")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic package file")
    agents = agents if agents is not None else AGENT_MANIFEST.read_bytes()
    (source / "deploy/linux/agents.json").write_bytes(agents)
    for name in ("adapter", "media"):
        (source / "node_modules" / name).mkdir(parents=True, exist_ok=True)
        (source / "node_modules" / name / "package.json").write_text(json.dumps({"name": name, "version": "1.0.0"}))
    manifest = {"dependencies": {"adapter": "1.0.0", "media": "1.0.0", **agent_pins(agents)}, "devDependencies": {name: "1.0.0" for name in DEVELOPMENT}}
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
                launcher = source / "node_modules/.bin/adapter"
                launcher.parent.mkdir(parents=True, exist_ok=True)
                launcher.symlink_to(executable)
                runtime = self.root / ("bun-" + str(index))
                runtime.write_bytes(b"synthetic Bun runtime")
                output = self.root / ("package-" + str(index))
                arguments = argparse.Namespace(source=source, bun=runtime, version="1.2.3", platform={"x86_64":"linux-x64","aarch64":"linux-arm64"}[platform.machine()], output=output, mise=None, gh=None)
                with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.4\n")), mock.patch.object(packager, "install_production", return_value=source / "node_modules"), mock.patch.object(packager.release, "download_mise", return_value=b"\x7fELFsynthetic-mise"), mock.patch.object(packager.release, "download_gh", return_value=b"\x7fELFsynthetic-gh"):
                    if index == 0:
                        packager.pack(arguments)
                        members = release.inspect_archive(output / "artifact.tar")
                        self.assertIn("app/node_modules/" + target, members)
                        self.assertEqual(members["bin/paws-runner"].mode, 0o755)
                        self.assertEqual(members["bin/mise"].mode, 0o755)
                        with tarfile.open(output / "artifact.tar") as archive:
                            self.assertEqual(archive.extractfile("bin/paws-runner").read(), release.RUNNER_LAUNCHER)
                            adapter = archive.extractfile("app/node_modules/.bin/adapter").read().decode()
                            self.assertIn("exec /opt/paws-runner/bin/bun --no-env-file '/opt/paws-runner/current/node_modules/" + target, adapter)
                            self.assertNotIn("/usr/bin/node", adapter)
                        self.assertFalse(any(name.startswith("app/node_modules/.bin/") and name.rsplit("/", 1)[1] in release.PROVIDER_EXECUTABLES for name in members))
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
        arguments = argparse.Namespace(source=source, bun=runtime, version="1.2.3", platform={"x86_64":"linux-x64","aarch64":"linux-arm64"}[platform.machine()], output=output, mise=None, gh=None)
        with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.4\n")), mock.patch.object(packager, "install_production", return_value=source / "node_modules"), mock.patch.object(packager.release, "download_mise", return_value=b"\x7fELFsynthetic-mise"), mock.patch.object(packager.release, "download_gh", return_value=b"\x7fELFsynthetic-gh"):
            packager.pack(arguments)
        members = release.inspect_archive(output / "artifact.tar")
        self.assertIn("app/node_modules/media/index.js", members)
        self.assertFalse(any("av01" in name or "odd" in name for name in members))
        (source / "src/bad,name.ts").write_bytes(b"source")
        with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.4\n")), mock.patch.object(packager, "install_production", return_value=source / "node_modules"), mock.patch.object(packager.release, "download_mise", return_value=b"\x7fELFsynthetic-mise"), mock.patch.object(packager.release, "download_gh", return_value=b"\x7fELFsynthetic-gh"):
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
        (production / ".bin").mkdir(exist_ok=True)
        (production / ".bin/tsc").symlink_to("../typescript/bin/tsc")
        runtime = self.root / "bun-production"
        runtime.write_bytes(b"synthetic Bun runtime")
        arguments = argparse.Namespace(source=source, bun=runtime, version="1.2.3", platform={"x86_64":"linux-x64","aarch64":"linux-arm64"}[platform.machine()], output=self.root / "package-production", mise=None, gh=None)
        def patches():
            return mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.4\n")), mock.patch.object(packager, "install_production", return_value=production), mock.patch.object(packager.release, "download_mise", return_value=b"\x7fELFsynthetic-mise"), mock.patch.object(packager.release, "download_gh", return_value=b"\x7fELFsynthetic-gh")
        first, second, third, fourth = patches()
        with first, second, third, fourth:
            packager.pack(arguments)
        members = release.inspect_archive(self.root / "package-production/artifact.tar")
        self.assertLessEqual(release.REQUIRED, members.keys())
        self.assertFalse(any(name.startswith("app/node_modules/@agentclientprotocol/claude-agent-acp/") for name in members))
        self.assertIn("app/node_modules/media/index.js", members)
        packages = {name for member in members if member.startswith("app/node_modules/") for name in packager.package_names(tuple(member.removeprefix("app/node_modules/").split("/")))}
        self.assertEqual({name for name in packages if name.endswith("-musl")}, set())
        self.assertEqual(packages & set(DEVELOPMENT), set())
        self.assertNotIn("app/node_modules/.bin/tsc", members)
        self.assertFalse(any("only-in-checkout" in name for name in members))
        (production / "media/package.json").write_text(json.dumps({"name": "media", "dependencies": {"typescript": "1.0.0"}}))
        first, second, third, fourth = patches()
        with first, second, third, fourth:
            with self.assertRaisesRegex(ValueError, "needs a development dependency: typescript"):
                packager.pack(argparse.Namespace(**{**vars(arguments), "output": self.root / "package-production-hard"}))

    def test_packaging_refuses_agent_pins_that_differ_from_package_json(self):
        specification = importlib.util.spec_from_file_location("packager", pathlib.Path(sys.argv[1]).with_name("package.py"))
        packager = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(packager)
        source = self.root / "source-agent-pins"
        synthetic_source(source)
        manifest = json.loads((source / "package.json").read_text())
        manifest["dependencies"]["@agentclientprotocol/codex-acp"] = "9.9.9"
        (source / "package.json").write_text(json.dumps(manifest))
        runtime = self.root / "bun-agent-pins"
        runtime.write_bytes(b"synthetic Bun runtime")
        arguments = argparse.Namespace(source=source, bun=runtime, version="1.2.3", platform={"x86_64":"linux-x64","aarch64":"linux-arm64"}[platform.machine()], output=self.root / "package-agent-pins", mise=None, gh=None)
        with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.4\n")), mock.patch.object(packager, "install_production", return_value=source / "node_modules"):
            with self.assertRaisesRegex(ValueError, "agent-manifest.py"):
                packager.pack(arguments)

    def test_archive_that_ships_a_coding_agent_is_rejected(self):
        for extra in ("app/node_modules/@openai/codex/bin/codex.js", "app/node_modules/@xai-official/grok/package.json", "app/node_modules/.bin/claude-agent-acp"):
            with self.subTest(extra=extra):
                with tarfile.open(self.artifact, "w") as archive:
                    for name in release.REQUIRED | {extra}:
                        member = tarfile.TarInfo(name)
                        member.mode = 0o755
                        archive.addfile(member, io.BytesIO())
                with self.assertRaisesRegex(ValueError, "agents.json"):
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
        arguments = argparse.Namespace(source=source, bun=runtime, version="1.2.3", platform={"x86_64":"linux-x64","aarch64":"linux-arm64"}[platform.machine()], output=self.root / "package-mise", mise=mise, gh=None)
        with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.4\n")), mock.patch.object(packager, "install_production", return_value=source / "node_modules"):
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
            for name in sorted(release.REQUIRED | {"app/node_modules/yaml/package.json", "app/node_modules/.bin/yaml"}):
                member = tarfile.TarInfo(name)
                content = b"synthetic reviewed release file"
                member.size = len(content)
                member.mode = 0o755 if name in release.BINARIES else 0o644
                archive.addfile(member, io.BytesIO(content))
            if extra is not None:
                archive.addfile(extra, io.BytesIO(b"x" * extra.size) if extra.isfile() else None)

    def sign(self, changes=None):
        manifest = {"format": 1, "version": "1.2.3", "platform": {"x86_64": "linux-x64", "aarch64": "linux-arm64"}[platform.machine()], "bunVersion": "1.4.4", "artifactSha256": hashlib.sha256(self.artifact.read_bytes()).hexdigest()}
        manifest.update(changes or {})
        self.manifest.write_text(json.dumps(manifest))
        self.openssl("pkeyutl", "-sign", "-rawin", "-inkey", str(self.private), "-in", str(self.manifest), "-out", str(self.signature))

    def verify(self):
        with tempfile.TemporaryDirectory(dir=self.root) as staging:
            arguments = argparse.Namespace(manifest=self.manifest, signature=self.signature, artifact=self.artifact, release_key=self.key)
            return release.verify_release(arguments, pathlib.Path(staging))[0]

    def test_exact_signed_manifest_and_artifact_verify(self):
        self.assertEqual(self.verify()["version"], "1.2.3")
        self.assertEqual(self.verify()["bunVersion"], "1.4.4")

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


def load(name):
    specification = importlib.util.spec_from_file_location(name.replace("-", "_"), pathlib.Path(sys.argv[1]).with_name(name + ".py"))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


BUN = os.environ.get("PAWS_TEST_BUN") or shutil.which("bun")
ARCH, TRIPLE = release.ARCHITECTURE
NODE_AGENT = """#!/usr/bin/env node
const input = require("readline").createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { name: NAME, version: VERSION, argv: process.argv.slice(2), file: __filename } }) + "\\n");
});
"""
NATIVE_AGENT = """#!/bin/sh
read -r line
printf '{"jsonrpc":"2.0","id":1,"result":{"name":"NAME","version":"VERSION","argv":["%s"],"file":"%s"}}\\n' "$*" "$0"
exec cat >/dev/null
"""


def node_agent(name, version):
    return NODE_AGENT.replace("NAME", json.dumps(name)).replace("VERSION", json.dumps(version)).encode()


def native_agent(name, version):
    return NATIVE_AGENT.replace("NAME", name).replace("VERSION", version).encode()


def fake_packages(version, marker):
    """Stand-ins for every package the three agents install, with the files the launchers and installer expect."""
    vendor = f"vendor/{TRIPLE}-unknown-linux-musl"
    return {
        "@agentclientprotocol/claude-agent-acp": ({"bin": {"claude-agent-acp": "dist/index.js"}, "dependencies": {f"@anthropic-ai/claude-agent-sdk-linux-{ARCH}": version, f"@anthropic-ai/claude-agent-sdk-linux-{ARCH}-musl": version}}, {"dist/index.js": (node_agent("claude-agent-acp", version), 0o755)}),
        f"@anthropic-ai/claude-agent-sdk-linux-{ARCH}": ({}, {"claude": (native_agent("claude", version), 0o755)}),
        f"@anthropic-ai/claude-agent-sdk-linux-{ARCH}-musl": ({}, {"claude": (native_agent("claude-musl", version), 0o755)}),
        "@agentclientprotocol/codex-acp": ({"bin": {"codex-acp": "dist/index.js"}, "dependencies": {"@openai/codex": version, f"@openai/codex-linux-{ARCH}": version}}, {"dist/index.js": (node_agent("codex-acp", version), 0o755)}),
        "@openai/codex": ({"bin": {"codex": "bin/codex.js"}}, {"bin/codex.js": (node_agent("codex", version), 0o755)}),
        f"@openai/codex-linux-{ARCH}": ({}, {f"{vendor}/bin/codex": (native_agent("codex-native", version), 0o755), f"{vendor}/bin/codex-code-mode-host": (b"#!/bin/sh\n", 0o755), f"{vendor}/codex-resources/voice/bin/codex-voice-host": (b"#!/bin/sh\n", 0o755), f"{vendor}/codex-resources/bwrap": (b"#!/bin/sh\n", 0o755)}),
        "@opencode/cli": ({"optionalDependencies": {f"@opencode/cli-linux-{ARCH}{'-baseline' if ARCH == 'x64' else ''}": version}}, {}),
        f"@opencode/cli-linux-{ARCH}{'-baseline' if ARCH == 'x64' else ''}": ({}, {"bin/opencode": (native_agent("opencode", version), 0o755)}),
        "@xai-official/grok": ({"bin": {"grok": "bin/grok"}, "scripts": {"postinstall": f"touch {marker}"}}, {"bin/grok": (node_agent("grok", version), 0o755)}),
    }


def tarball(name, version, metadata, files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path, (content, mode) in {"package.json": (json.dumps({"name": name, "version": version, **metadata}).encode(), 0o644), **files}.items():
            member = tarfile.TarInfo("package/" + path)
            member.size = len(content)
            member.mode = mode
            archive.addfile(member, io.BytesIO(content))
    return buffer.getvalue()


def integrity(content):
    import base64
    return "sha512-" + base64.b64encode(hashlib.sha512(content).digest()).decode()


class FakeRegistry:
    """npm registry on 127.0.0.1 serving packuments and tarballs; `served` can be swapped to tamper a tarball."""

    def __init__(self):
        import http.server
        import threading
        import urllib.parse
        self.packuments = {}
        self.served = {}
        self.requests = []
        registry = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                path = urllib.parse.unquote(self.path).lstrip("/")
                registry.requests.append(path)
                content = registry.served.get(path) if path.endswith(".tgz") else json.dumps(registry.packuments[path]).encode() if path in registry.packuments else None
                if content is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)

            def log_message(self, *_):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def publish(self, name, version, metadata, files):
        content = tarball(name, version, metadata, files)
        path = f"{name}/-/{name.split('/')[-1]}-{version}.tgz"
        self.served[path] = content
        packument = self.packuments.setdefault(name, {"name": name, "dist-tags": {}, "versions": {}})
        packument["versions"][version] = {"name": name, "version": version, **metadata, "dist": {"tarball": self.url + path, "integrity": integrity(content)}}
        packument["dist-tags"]["latest"] = version
        return path

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@unittest.skipIf(BUN is None, "the pinned Bun is required to install agents")
class AgentInstallation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="paws-agent-test-")
        cls.root = pathlib.Path(cls.temporary.name)
        cls.marker = cls.root / "install-script-ran"
        cls.registry = FakeRegistry()
        cls.paths = {}
        for version in ("1.0.0", "2.0.0"):
            for name, (metadata, files) in fake_packages(version, cls.marker).items():
                cls.paths[(name, version)] = cls.registry.publish(name, version, metadata, files)
        generator = load("agent-manifest")
        cls.manifests = {}
        for version in ("1.0.0", "2.0.0"):
            agents = {}
            for agent in release.AGENT_PACKAGES:
                workspace = cls.root / f"lock-{agent}-{version}"
                workspace.mkdir()
                agents[agent] = generator.agent_entry(BUN, agent, version, workspace, registry=cls.registry.url)
            cls.manifests[version] = json.dumps({"format": 1, "agents": agents}, indent=2)
        cls.original = dict(cls.registry.served)

    @classmethod
    def tearDownClass(cls):
        cls.registry.close()
        cls.temporary.cleanup()

    def setUp(self):
        self.registry.served = dict(self.original)
        self.marker.unlink(missing_ok=True)
        self.installer = load("install")
        self.work = pathlib.Path(tempfile.mkdtemp(prefix="case-", dir=self.root))
        self.base = self.work / "opt"
        (self.base / "bin").mkdir(parents=True)
        (self.base / "bin/bun").symlink_to(BUN)
        self.installer.root_directory = lambda path, mode=0o755: path.mkdir(parents=True, exist_ok=True)
        self.installer.STATE = self.work / "state"
        self.installer.STATE.mkdir(mode=0o700)

    def manifest(self, version):
        return release.parse_agent_manifest(self.manifests[version])

    def install(self, version):
        return self.installer.install_agents(self.manifest(version), BUN, self.base, self.registry.url)

    def current(self, agent):
        return os.readlink(self.base / "agents" / agent / "current")

    def session(self, launcher, *arguments):
        """Start a launcher and wait until the fake agent answers, so its version folder is held."""
        process = subprocess.Popen([str(self.base / "bin" / launcher), *arguments], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin", "HOME": str(self.work)})
        process.stdin.write(b'{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
        process.stdin.flush()
        answer = json.loads(process.stdout.readline() or b"null")
        def cleanup():
            if process.poll() is None:
                process.kill()
                process.wait()
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()
        self.addCleanup(cleanup)
        return process, answer

    def finish(self, process):
        process.stdin.close()
        self.assertEqual(process.wait(timeout=10), 0, process.stderr.read().decode())

    def test_package_install_then_agents_install_and_each_launcher_runs_a_fake_task(self):
        packager = load("package")
        source = self.work / "source"
        synthetic_source(source, self.manifests["1.0.0"].encode())
        output = self.work / "package"
        arguments = argparse.Namespace(source=source, bun=pathlib.Path(BUN), version="1.2.3", platform={"x86_64": "linux-x64", "aarch64": "linux-arm64"}[platform.machine()], output=output, mise=None, gh=None)
        if subprocess.run([BUN, "--version"], capture_output=True, check=True).stdout.decode().strip() != release.BUN_VERSION:
            self.skipTest("the pinned Bun version is required")
        with mock.patch.object(packager, "install_production", return_value=source / "node_modules"), mock.patch.object(packager.release, "download_mise", return_value=b"\x7fELFsynthetic-mise"), mock.patch.object(packager.release, "download_gh", return_value=b"\x7fELFsynthetic-gh"):
            packager.pack(arguments)
        unpacked = self.work / "unpacked"
        unpacked.mkdir()
        self.installer.extract_verified(output / "artifact.tar", unpacked)
        self.assertEqual((unpacked / "deploy/linux/agents.json").read_text(), self.manifests["1.0.0"])
        self.assertFalse((unpacked / "app/node_modules/@agentclientprotocol/claude-agent-acp").exists())
        lock = self.work / "agents.lock"
        with mock.patch.object(self.installer, "lock_agents", lambda: os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)):
            manifest = self.installer.prepare_agents(output / "artifact.tar", self.base, self.registry.url)
            statuses = self.installer.finish_agents(manifest, self.base)
        self.assertEqual(statuses, {agent: {"version": "1.0.0", "status": "installed"} for agent in release.AGENT_PACKAGES})
        expected = {"claude-agent-acp": "claude-agent-acp", "claude": "claude", "codex-acp": "codex-acp", "codex": "codex", "grok": "grok", "opencode": "opencode"}
        for launcher, (agent, target, _) in release.PROVIDER_EXECUTABLES.items():
            with self.subTest(launcher=launcher):
                folder = self.base / "agents" / agent / "1.0.0"
                process, answer = self.session(launcher, "task", "it's spaced")
                self.assertEqual(answer["result"]["name"], expected[launcher])
                self.assertEqual(answer["result"]["version"], "1.0.0")
                self.assertEqual(answer["result"]["argv"], ["task", "it's spaced"] if release.PROVIDER_EXECUTABLES[launcher][2] else ["task it's spaced"])
                self.assertEqual(pathlib.Path(answer["result"]["file"]).resolve(), (folder / target).resolve())
                self.assertTrue(self.installer.held(folder))
                self.finish(process)
                self.assertFalse(self.installer.held(folder))
        codex = self.base / "agents/codex/1.0.0" / release.CODEX_VENDOR
        self.assertFalse((codex / "codex-resources/voice").exists())
        self.assertTrue((codex / "bin/codex-code-mode-host").is_file())
        self.assertTrue((codex / "codex-resources/bwrap").is_file())
        sdk = self.base / "agents/claude/1.0.0/node_modules/@anthropic-ai"
        self.assertEqual(sorted(path.name for path in sdk.iterdir()), [f"claude-agent-sdk-linux-{ARCH}"])

    def test_a_tarball_whose_integrity_does_not_match_is_refused_and_the_previous_version_stays(self):
        self.install("1.0.0")
        self.installer.activate_agents(self.manifest("1.0.0"), self.base)
        path = self.paths[(f"@openai/codex-linux-{ARCH}", "2.0.0")]
        metadata, files = fake_packages("2.0.0", self.marker)[f"@openai/codex-linux-{ARCH}"]
        self.registry.served[path] = tarball(f"@openai/codex-linux-{ARCH}", "2.0.0", metadata, {**files, "extra": (b"tampered", 0o644)})
        with self.assertRaisesRegex(self.installer.AgentInstallError, r"Coding agent codex 2\.0\.0 was not installed: .*[Ii]ntegrity") as raised:
            self.install("2.0.0")
        self.assertEqual(raised.exception.agent, "codex")
        self.assertIn(path, self.registry.requests)
        self.assertFalse((self.base / "agents/codex/2.0.0").exists())
        self.assertEqual(sorted(path.name for path in (self.base / "agents/codex").iterdir()), ["1.0.0", "current"])
        for agent in release.AGENT_PACKAGES:
            self.assertEqual(self.current(agent), "1.0.0")
        process, answer = self.session("codex-acp")
        self.assertEqual(answer["result"]["version"], "1.0.0")
        self.finish(process)

    def test_a_manifest_whose_lockfile_and_pins_differ_is_refused_before_bun_runs(self):
        changes = (
            lambda manifest: manifest["agents"]["codex"]["packages"][0].update(integrity="sha512-" + "A" * 86 + "=="),
            lambda manifest: manifest["agents"]["codex"]["lockfile"]["packages"]["@openai/codex"].__setitem__(1, self.registry.url + "elsewhere.tgz"),
            lambda manifest: manifest["agents"]["codex"]["packages"].pop(),
            lambda manifest: manifest["agents"]["grok"]["lockfile"].__setitem__("trustedDependencies", ["@xai-official/grok"]),
            lambda manifest: manifest["agents"]["claude"].__setitem__("version", "2.0.0"),
            lambda manifest: manifest["agents"].pop("grok"),
        )
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                manifest = json.loads(self.manifests["1.0.0"])
                change(manifest)
                with self.assertRaises(ValueError):
                    release.parse_agent_manifest(json.dumps(manifest))

    def test_install_scripts_do_not_run(self):
        control = self.work / "control"
        control.mkdir()
        (control / "package.json").write_text(json.dumps({**release.agent_package_json("grok", "1.0.0"), "trustedDependencies": ["@xai-official/grok"]}))
        subprocess.run([BUN, "install"], cwd=control, env={**release.COMMAND_ENV, "HOME": str(self.work), "BUN_INSTALL_CACHE_DIR": str(self.work / "control-cache"), "BUN_CONFIG_REGISTRY": self.registry.url}, capture_output=True, check=True, timeout=60)
        self.assertTrue(self.marker.exists(), "the fake package's postinstall runs when scripts are allowed")
        self.marker.unlink()
        calls = []
        run = subprocess.run
        def recording(arguments, **options):
            calls.append(arguments)
            return run(arguments, **options)
        with mock.patch.object(self.installer.subprocess, "run", side_effect=recording):
            self.install("1.0.0")
        self.assertFalse(self.marker.exists())
        self.assertTrue(all("--ignore-scripts" in arguments and "--frozen-lockfile" in arguments for arguments in calls))
        self.assertEqual(len(calls), len(release.AGENT_PACKAGES))

    def test_a_second_version_installs_beside_the_first_and_current_waits_for_sessions_on_the_old_one(self):
        self.install("1.0.0")
        self.assertEqual(self.installer.activate_agents(self.manifest("1.0.0"), self.base)["claude"]["status"], "installed")
        first = self.base / "agents/claude/1.0.0"
        snapshot = {path: path.read_bytes() for path in first.rglob("*") if path.is_file() and not path.is_symlink()}
        process, answer = self.session("claude-agent-acp")
        self.assertEqual(answer["result"]["version"], "1.0.0")
        self.install("2.0.0")
        self.assertEqual(sorted(path.name for path in (self.base / "agents/claude").iterdir()), ["1.0.0", "2.0.0", "current"])
        statuses = self.installer.activate_agents(self.manifest("2.0.0"), self.base)
        self.assertEqual(statuses["claude"], {"version": "2.0.0", "status": "waiting"})
        self.assertEqual(self.current("claude"), "1.0.0")
        self.assertEqual({agent: statuses[agent]["status"] for agent in ("codex", "grok")}, {"codex": "installed", "grok": "installed"})
        self.assertEqual(self.current("codex"), "2.0.0")
        self.finish(process)
        self.assertEqual(self.installer.activate_agents(self.manifest("2.0.0"), self.base)["claude"]["status"], "installed")
        self.assertEqual(self.current("claude"), "2.0.0")
        self.assertEqual({path: path.read_bytes() for path in first.rglob("*") if path.is_file() and not path.is_symlink()}, snapshot)
        inode = first.stat().st_ino
        self.installer.install_agent_version("claude", self.manifest("1.0.0")["agents"]["claude"], BUN, self.base, self.registry.url)
        self.assertEqual(first.stat().st_ino, inode)
        process, answer = self.session("claude-agent-acp")
        self.assertEqual(answer["result"]["version"], "2.0.0")
        self.finish(process)


    def test_a_release_whose_pin_is_older_keeps_the_newer_current_version(self):
        self.install("1.0.0")
        self.install("2.0.0")
        self.installer.activate_agents(self.manifest("2.0.0"), self.base)
        statuses = self.installer.activate_agents(self.manifest("1.0.0"), self.base)
        self.assertEqual(statuses["claude"], {"version": "2.0.0", "status": "kept"})
        for agent in ("claude", "codex", "grok"):
            self.assertEqual(self.current(agent), "2.0.0")

    def test_newer_compares_exact_versions(self):
        self.assertTrue(self.installer.newer("0.99.1", "0.88.0"))
        self.assertTrue(self.installer.newer("2.10.0", "2.9.9"))
        self.assertFalse(self.installer.newer("2.1.1", "2.5.0"))
        self.assertFalse(self.installer.newer("1.0.0-rc.1", "1.0.0"))
        self.assertFalse(self.installer.newer("1.0.0", "1.0.0"))

    def published_integrity(self, agent, version):
        return self.registry.packuments[release.AGENT_PACKAGES[agent]]["versions"][version]["dist"]["integrity"]

    def request(self, agent, version, request_id, integrity=True, native=None, packages=None):
        """A request as Paws sends it: the catalog's integrity for the agent and for its native build package.

        Paws never sends an empty package list. Where these fake packages have no separate native build,
        the agent package itself stands in as the one checked pin.
        """
        name = release.AGENT_NATIVE_PACKAGE[agent]
        if packages is None:
            published = self.registry.packuments.get(name, {}).get("versions", {}).get(native)
            packages = [{"name": name, "version": native, "integrity": published["dist"]["integrity"] if published else "sha512-" + "Q" * 86 + "=="}] if native is not None and name != release.AGENT_PACKAGES[agent] else [self.agent_pin(agent, version)]
        return {"id": request_id, "agent": agent, "version": version, "integrity": self.published_integrity(agent, version) if integrity is True else integrity, "nativeVersion": native, "packages": packages}

    def agent_pin(self, agent, version):
        return {"name": release.AGENT_PACKAGES[agent], "version": version, "integrity": self.published_integrity(agent, version)}

    def process(self, requests, sleep=None):
        """Run `install.py agent-requests` against this case's folders, as paws-runner-agents.service does."""
        path = self.work / "agent-requests.json"
        path.write_text(json.dumps({"format": 1, "requests": requests}))
        lock = self.work / "agents.lock"
        with mock.patch.object(self.installer, "lock_agents", lambda: os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)):
            return self.installer.process_agent_requests(BUN, self.base, self.registry.url, path, self.work / "status/status.json", sleep or (lambda _: self.fail("nothing should wait")))

    def installed_one(self):
        self.install("1.0.0")
        self.installer.activate_agents(self.manifest("1.0.0"), self.base)

    def test_an_update_request_installs_the_version_paws_sent_and_reports_it(self):
        self.installed_one()
        status = self.process([self.request("codex", "2.0.0", "update-1", native="2.0.0")])
        self.assertEqual(self.current("codex"), "2.0.0")
        self.assertEqual(self.current("claude"), "1.0.0")
        self.assertEqual(status["agents"]["codex"], {"current": "2.0.0", "request": {"id": "update-1", "version": "2.0.0", "status": "installed"}})
        self.assertEqual(json.loads((self.work / "status/status.json").read_text()), status)
        process, answer = self.session("codex-acp")
        self.assertEqual(answer["result"]["version"], "2.0.0")
        self.finish(process)
        # A request already applied is not applied again.
        self.registry.requests.clear()
        self.process([self.request("codex", "2.0.0", "update-1", native="2.0.0")])
        self.assertEqual(self.registry.requests, [])

    def test_a_version_or_integrity_paws_did_not_send_is_refused(self):
        self.installed_one()
        other = self.published_integrity("codex", "1.0.0")
        status = self.process([
            self.request("codex", "2.0.0", "wrong-integrity", integrity=other),
            self.request("claude", "2.0.0", "wrong-native", native="9.9.9"),
        ])
        self.assertEqual(status["agents"]["codex"]["request"]["status"], "failed")
        self.assertIn("is not the one Paws sent", status["agents"]["codex"]["request"]["error"])
        self.assertEqual(status["agents"]["claude"]["request"]["status"], "failed")
        self.assertFalse((self.base / "agents/codex/2.0.0").exists())
        self.assertEqual(self.current("codex"), "1.0.0")
        self.assertEqual(self.current("claude"), "1.0.0")
        for content in ('{"format": 1, "requests": [{"id": "x", "agent": "left-pad", "version": "1.0.0", "integrity": null, "nativeVersion": null, "packages": []}]}', '{"format": 1, "requests": [{"id": "x", "agent": "codex", "version": "../1", "integrity": null, "nativeVersion": null, "packages": []}]}', '{"format": 1, "requests": [{"id": "x", "agent": "codex", "version": "2.0.0", "integrity": "sha1-abc", "nativeVersion": null, "packages": []}]}'):
            with self.subTest(content=content), self.assertRaises(ValueError):
                release.parse_agent_requests(content)
        # Every request carries the agent package's sha512 and at least one checked package.
        for request in ({**self.request("grok", "2.0.0", "x"), "integrity": None}, {**self.request("grok", "2.0.0", "x"), "packages": []}):
            content = json.dumps({"format": 1, "requests": [request]})
            with self.subTest(content=content), self.assertRaises(ValueError):
                release.parse_agent_requests(content)

    def test_a_ranged_native_dependency_resolves_the_version_the_catalog_checked(self):
        """codex-acp 3.0.0 accepts any @openai/codex ^2.0.0; npm also has 2.1.0, still inside its 48 hours."""
        vendor_packages = fake_packages("2.1.0", self.marker)
        metadata, files = vendor_packages["@openai/codex"]
        self.registry.publish("@openai/codex", "2.1.0", metadata, files)
        adapter_metadata, adapter_files = fake_packages("3.0.0", self.marker)["@agentclientprotocol/codex-acp"]
        adapter_metadata = {**adapter_metadata, "dependencies": {"@openai/codex": "^2.0.0", f"@openai/codex-linux-{ARCH}": "2.0.0"}}
        self.registry.publish("@agentclientprotocol/codex-acp", "3.0.0", adapter_metadata, adapter_files)
        self.addCleanup(lambda: [self.registry.packuments[name]["versions"].pop(version, None) for name, version in (("@openai/codex", "2.1.0"), ("@agentclientprotocol/codex-acp", "3.0.0"))])
        self.installed_one()
        status = self.process([self.request("codex", "3.0.0", "ranged", native="2.0.0")])
        self.assertEqual(status["agents"]["codex"]["request"], {"id": "ranged", "version": "3.0.0", "status": "installed"})
        installed = json.loads((self.base / "agents/codex/3.0.0/node_modules/@openai/codex/package.json").read_text())
        self.assertEqual(installed["version"], "2.0.0")
        self.assertEqual(self.current("codex"), "3.0.0")

    def test_platform_builds_published_as_versions_of_the_native_package_are_accepted(self):
        """@openai/codex 0.160.1 pulls its platform builds through npm aliases such as npm:@openai/codex@0.160.1-linux-x64."""
        sums = {name: "sha512-" + letter * 86 + "==" for name, letter in (("acp", "A"), ("native", "B"), ("linux", "C"), ("darwin", "D"))}
        packages = [
            {"path": "@agentclientprotocol/codex-acp", "name": "@agentclientprotocol/codex-acp", "version": "2.2.2", "integrity": sums["acp"]},
            {"path": "@openai/codex", "name": "@openai/codex", "version": "0.160.1", "integrity": sums["native"]},
            {"path": "@openai/codex-linux-x64", "name": "@openai/codex", "version": "0.160.1-linux-x64", "integrity": sums["linux"]},
            {"path": "@openai/codex-darwin-arm64", "name": "@openai/codex", "version": "0.160.1-darwin-arm64", "integrity": sums["darwin"]},
        ]
        pins = [
            {"name": "@openai/codex", "version": "0.160.1", "integrity": sums["native"]},
            {"name": "@openai/codex", "version": "0.160.1-linux-x64", "integrity": sums["linux"]},
            {"name": "@openai/codex", "version": "0.160.1-darwin-arm64", "integrity": sums["darwin"]},
        ]
        request = {"id": "aliases", "agent": "codex", "version": "2.2.2", "integrity": sums["acp"], "nativeVersion": "0.160.1", "packages": pins}
        self.installer.verify_requested_packages(request, packages)
        unchecked = {**request, "packages": pins[:2]}
        with self.assertRaisesRegex(self.installer.AgentInstallError, "@openai/codex@0.160.1-darwin-arm64 does not carry the integrity Paws checked"):
            self.installer.verify_requested_packages(unchecked, packages)
        other = [*packages, {"path": "x/node_modules/@openai/codex", "name": "@openai/codex", "version": "0.161.0", "integrity": sums["native"]}]
        with self.assertRaisesRegex(self.installer.AgentInstallError, "not 0.160.1 as Paws checked"):
            self.installer.verify_requested_packages(request, other)

    def test_a_native_package_with_bytes_other_than_the_catalog_checked_is_refused(self):
        self.installed_one()
        wrong = [{"name": "@openai/codex", "version": "2.0.0", "integrity": self.published_integrity("codex", "1.0.0")}]
        status = self.process([self.request("codex", "2.0.0", "native-bytes", native="2.0.0", packages=wrong)])
        self.assertEqual(status["agents"]["codex"]["request"]["status"], "failed")
        self.assertIn("@openai/codex@2.0.0 does not carry the integrity Paws checked", status["agents"]["codex"]["request"]["error"])
        self.assertFalse((self.base / "agents/codex/2.0.0").exists())
        # Paws must name the native package's integrity, not only its version.
        status = self.process([self.request("codex", "2.0.0", "native-missing", native="2.0.0", packages=[self.agent_pin("codex", "2.0.0")])])
        self.assertIn("Paws sent no integrity for @openai/codex@2.0.0", status["agents"]["codex"]["request"]["error"])
        self.assertEqual(self.current("codex"), "1.0.0")
        with self.assertRaises(ValueError):
            release.parse_agent_requests(json.dumps({"format": 1, "requests": [{**self.request("codex", "2.0.0", "x", native="2.0.0"), "packages": [{"name": "../x", "version": "1.0.0", "integrity": self.published_integrity("codex", "2.0.0")}]}]}))

    def test_an_installed_version_is_checked_against_the_integrity_recorded_when_it_was_installed(self):
        self.installed_one()
        self.install("2.0.0")
        self.assertTrue((self.base / "agents/codex/2.0.0" / self.installer.AGENT_PACKAGE_RECORD).is_file())
        self.registry.requests.clear()
        status = self.process([self.request("codex", "2.0.0", "wrong-installed", integrity=self.published_integrity("codex", "1.0.0"), native="2.0.0")])
        self.assertEqual(status["agents"]["codex"]["request"]["status"], "failed")
        self.assertIn("is not the one Paws sent", status["agents"]["codex"]["request"]["error"])
        self.assertEqual(self.current("codex"), "1.0.0")
        status = self.process([self.request("codex", "2.0.0", "right-installed", native="2.0.0")])
        self.assertEqual(status["agents"]["codex"]["request"]["status"], "installed")
        self.assertEqual(self.current("codex"), "2.0.0")
        self.assertEqual(self.registry.requests, [])
        # A folder with no record (installed before records existed) is refused unless the installed
        # release's agents.json names that version.
        (self.base / "agents/grok/2.0.0" / self.installer.AGENT_PACKAGE_RECORD).unlink()
        status = self.process([self.request("grok", "2.0.0", "no-record")])
        self.assertIn("without a record of its integrity", status["agents"]["grok"]["request"]["error"])
        (self.base / "current/deploy/linux").mkdir(parents=True)
        (self.base / "current/deploy/linux/agents.json").write_text(self.manifests["2.0.0"])
        status = self.process([self.request("grok", "2.0.0", "from-manifest")])
        self.assertEqual(status["agents"]["grok"]["request"]["status"], "installed")
        self.assertEqual(self.current("grok"), "2.0.0")

    def test_a_running_session_keeps_its_version_until_it_ends(self):
        self.installed_one()
        process, answer = self.session("claude-agent-acp")
        self.assertEqual(answer["result"]["version"], "1.0.0")
        checks = []
        def sleep(_):
            status = json.loads((self.work / "status/status.json").read_text())
            checks.append(status["agents"]["claude"]["request"])
            self.assertEqual(self.current("claude"), "1.0.0")
            if len(checks) == 2:
                self.finish(process)
        status = self.process([self.request("claude", "2.0.0", "update-2")], sleep)
        self.assertEqual(checks[0]["status"], "waiting")
        self.assertEqual(checks[0].get("sessions"), 1)
        self.assertEqual(len(checks), 2)
        self.assertEqual(status["agents"]["claude"]["request"], {"id": "update-2", "version": "2.0.0", "status": "installed"})
        self.assertEqual(self.current("claude"), "2.0.0")



class FakeDockerHost:
    """A fake root for rootless Docker setup: accounts, groups, the files it writes, and recording systemctl, usermod and gpasswd."""

    UNIT = """[Unit]
Description=Rootless Docker daemon for Paws runner work
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=paws-runner
Group=paws-runner
RuntimeDirectory=paws-docker
RuntimeDirectoryMode=0700
Environment=XDG_RUNTIME_DIR=/run/paws-docker
Environment=HOME=/var/lib/paws-runner-docker
Environment=PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin
ExecStart=/usr/lib/paws-runner-package/dockerd-rootless.sh --data-root /var/lib/paws-runner-docker/data --exec-root /run/paws-docker/exec --pidfile /run/paws-docker/docker.pid --host unix:///run/paws-docker/docker.sock --exec-opt native.cgroupdriver=cgroupfs
Delegate=yes
KillMode=mixed
Restart=on-failure
RestartSec=5s
LimitNOFILE=infinity
LimitNPROC=infinity
TasksMax=infinity

[Install]
WantedBy=multi-user.target
"""

    def __init__(self, installer, root, members=()):
        self.installer = installer
        self.root = root
        self.bin = root / "bin"
        self.bin.mkdir(parents=True)
        self.log = root / "commands.log"
        self.log.touch()
        self.members = root / "docker-members"
        self.members.write_text("".join(name + "\n" for name in members))
        # paws-runner is the test's own user, so the data directory can be given to it without root.
        uid, gid = os.getuid() or 60980, os.getgid() or 60980
        self.accounts = {"paws-runner": SimpleNamespace(pw_name="paws-runner", pw_uid=uid, pw_gid=gid), "paws-agent": SimpleNamespace(pw_name="paws-agent", pw_uid=uid + 1, pw_gid=60979)}
        self.groups = {"paws-runner": [gid, []], "paws-agent": [60979, ["paws-runner"]], "paws-results": [60981, ["paws-runner", "paws-agent"]], "docker": [60988, None], "sudo": [27, []]}
        for name in ("dockerd", "rootlesskit", "newuidmap", "newgidmap", "slirp4netns"):
            self.tool(name, "exit 0\n")
        log = shlex.quote(str(self.log))
        self.tool("systemctl", f'printf "systemctl %s\\n" "$*" >> {log}\n')
        self.tool("usermod", f'printf "usermod %s\\n" "$*" >> {log}\ncase "$1" in --add-subuids) file={shlex.quote(str(root / "etc/subuid"))} ;; --add-subgids) file={shlex.quote(str(root / "etc/subgid"))} ;; *) exit 2 ;; esac\nstart=${{2%-*}}; last=${{2#*-}}\nprintf "%s:%s:%s\\n" "$3" "$start" "$((last - start + 1))" >> "$file"\n')
        self.tool("gpasswd", f'printf "gpasswd %s\\n" "$*" >> {log}\ntest "$1 $2 $3" = "-d paws-runner docker" || exit 2\ngrep -vx paws-runner {shlex.quote(str(self.members))} > {shlex.quote(str(self.members))}.new || true\nmv {shlex.quote(str(self.members))}.new {shlex.quote(str(self.members))}\n')
        (root / "etc").mkdir()
        (root / "etc/subuid").write_text("")
        (root / "etc/subgid").write_text("")
        (root / "var/lib").mkdir(parents=True)
        (root / "state").mkdir()
        launcher = root / "usr/lib/paws-runner-package/dockerd-rootless.sh"
        launcher.parent.mkdir(parents=True)
        shutil.copyfile(pathlib.Path(sys.argv[1]).with_name("dockerd-rootless.sh"), launcher)
        launcher.chmod(0o755)
        self.probe = "ready"

    def tool(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)

    def path(self, name):
        return self.root / name.lstrip("/")

    def commands(self):
        return self.log.read_text().splitlines()

    def getpwnam(self, name):
        if name not in self.accounts:
            raise KeyError(name)
        return self.accounts[name]

    def getgrnam(self, name):
        if name not in self.groups:
            raise KeyError(name)
        gid, members = self.groups[name]
        return SimpleNamespace(gr_name=name, gr_gid=gid, gr_mem=self.members.read_text().split() if members is None else list(members))

    def getgrall(self):
        return [self.getgrnam(name) for name in self.groups]

    def getgrouplist(self, name, gid):
        return [gid, *(group.gr_gid for group in self.getgrall() if name in group.gr_mem and group.gr_gid != gid)]

    def write_atomic(self, path, content, mode):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(mode)

    def patches(self, installer=None):
        installer = installer or self.installer
        return [
            mock.patch.object(installer.pwd, "getpwnam", self.getpwnam),
            mock.patch.object(installer.grp, "getgrnam", self.getgrnam),
            mock.patch.object(installer.grp, "getgrall", self.getgrall),
            mock.patch.object(installer.os, "getgrouplist", self.getgrouplist),
            mock.patch.object(installer, "write_atomic", self.write_atomic),
            mock.patch.object(installer, "docker_probe", lambda: self.probe),
            mock.patch.object(installer, "DOCKER_PATH", str(self.bin)),
            mock.patch.object(installer, "DOCKER_LAUNCHER", self.path("/usr/lib/paws-runner-package/dockerd-rootless.sh")),
            mock.patch.object(installer, "DOCKER_UNIT", self.path("/etc/systemd/system/paws-docker.service")),
            mock.patch.object(installer, "DOCKER_DATA", self.path("/var/lib/paws-runner-docker")),
            mock.patch.object(installer, "DOCKER_SUBORDINATE", {"uid": self.path("/etc/subuid"), "gid": self.path("/etc/subgid")}),
            mock.patch.object(installer, "DOCKER_GROUP_GRANT", self.path("/state/docker-group.json")),
            mock.patch.object(installer, "SYSTEMCTL", str(self.bin / "systemctl")),
            mock.patch.object(installer, "USERMOD", str(self.bin / "usermod")),
            mock.patch.object(installer, "GPASSWD", str(self.bin / "gpasswd")),
        ]

    def snapshot(self):
        return {str(path.relative_to(self.root)): (path.read_bytes() if path.is_file() else None, stat.S_IMODE(path.lstat().st_mode)) for path in sorted(self.root.rglob("*")) if path != self.log}


def fake_install(order=None):
    """install() without the release: runs `prepare`, then starts the stop-to-start phase it would stop the runner in."""
    def install(manifest, artifact, fingerprint, reinstall=False, prepare=lambda: None, journal=None):
        prepared = prepare()
        journal.start("stop-to-start")
        if order is not None:
            order.append(("install",))
        return {"installed": True}, prepared
    return install


class DockerAccess(unittest.TestCase):
    def setUp(self):
        self.installer = load("install")
        self.temporary = tempfile.TemporaryDirectory(prefix="paws-docker-access-")
        self.host = FakeDockerHost(self.installer, pathlib.Path(self.temporary.name) / "root")

    def tearDown(self):
        self.temporary.cleanup()

    def configure(self, choice, host=None):
        host = host or self.host
        with contextlib.ExitStack() as stack:
            for patch in host.patches():
                stack.enter_context(patch)
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            return self.installer.configure_docker_access(choice)

    def validate(self):
        with contextlib.ExitStack() as stack:
            for patch in self.host.patches():
                stack.enter_context(patch)
            self.installer.validate_identity_separation()

    def test_grant_sets_up_the_rootless_daemon_for_paws_agent(self):
        host = self.host
        host.path("/etc/subuid").write_text("pascal:100000:65536\nbuilder:300000:10000\n")
        report = self.configure("grant")
        self.assertEqual((report["status"], report["changed"]), ("granted", True), report)
        self.assertEqual(host.path("/etc/systemd/system/paws-docker.service").read_text(), FakeDockerHost.UNIT)
        self.assertFalse(host.path("/etc/systemd/system/paws-agent@.service.d").exists())
        data = host.path("/var/lib/paws-runner-docker").lstat()
        self.assertTrue(stat.S_ISDIR(data.st_mode))
        self.assertEqual((data.st_uid, data.st_gid, stat.S_IMODE(data.st_mode)), (host.accounts["paws-runner"].pw_uid, host.accounts["paws-runner"].pw_gid, 0o700))
        # The highest range ends at 310000; the next 65536-aligned id is 327680. An empty file starts at 100000.
        self.assertEqual(host.path("/etc/subuid").read_text(), "pascal:100000:65536\nbuilder:300000:10000\npaws-runner:327680:65536\n")
        self.assertEqual(host.path("/etc/subgid").read_text(), "paws-runner:100000:65536\n")
        self.assertEqual(host.commands(), ["usermod --add-subuids 327680-393215 paws-runner", "usermod --add-subgids 100000-165535 paws-runner", "systemctl daemon-reload", "systemctl enable -- paws-docker.service", "systemctl restart -- paws-docker.service"])
        self.assertIn("/run/paws-docker/docker.sock", report["message"])
        self.assertNotIn("dockerGroup", report)

    def test_a_second_grant_changes_nothing(self):
        self.configure("grant")
        before = self.host.snapshot()
        self.host.log.write_text("")
        report = self.configure("grant")
        self.assertEqual((report["status"], report["changed"]), ("ready", False))
        self.assertEqual(self.host.snapshot(), before)
        self.assertEqual(self.host.commands(), ["systemctl enable --now -- paws-docker.service"])

    def test_a_missing_prerequisite_is_reported_and_nothing_is_set_up(self):
        for name in ("slirp4netns", "newgidmap"):
            (self.host.bin / name).unlink()
        before = self.host.snapshot()
        report = self.configure("grant")
        self.assertEqual((report["status"], report["changed"]), ("missing-prerequisites", False))
        self.assertIn("needs slirp4netns, uidmap", report["message"])
        self.assertNotIn("rootlesskit", report["message"])
        self.assertFalse(self.host.path("/etc/systemd/system/paws-docker.service").exists())
        self.assertEqual((self.host.snapshot(), self.host.commands()), (before, []))

    def test_package_configuration_finishes_when_a_prerequisite_is_missing(self):
        (self.host.bin / "rootlesskit").unlink()
        deb = load("deb-control")
        order = []
        state = pathlib.Path(self.temporary.name) / "debian-services.json"
        installer = deb.installer
        def command(arguments):
            order.append(tuple(arguments[1:]))
            return b""
        patches = [
            *self.host.patches(installer),
            mock.patch.object(deb, "RESTART", state),
            mock.patch.object(deb, "active_services", lambda: ["paws-runner.service"]),
            mock.patch.object(deb, "enabled_services", lambda: []),
            mock.patch.object(installer.release, "verify_release", lambda arguments, root: ({"version": "1.0.0"}, None, "key")),
            mock.patch.object(installer.release, "command", command),
            mock.patch.object(installer, "prepare_agents", lambda artifact: None),
            mock.patch.object(installer, "install", fake_install()),
            mock.patch.object(installer, "finish_agents", lambda agents: {}),
            mock.patch.object(installer, "prune", lambda: {"removed": []}),
            mock.patch.dict(os.environ, {"PAWS_RUNNER_DOCKER_ACCESS": "grant"}),
        ]
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            stack.enter_context(contextlib.redirect_stdout(output))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            deb.configure()
        installed = json.loads(output.getvalue().strip().splitlines()[-1])
        self.assertEqual(installed["docker"]["status"], "missing-prerequisites")
        self.assertIn(("start", "--", "paws-runner.service"), order)
        self.assertFalse(self.host.path("/etc/systemd/system/paws-docker.service").exists())

    def test_deny_removes_the_unit_and_keeps_the_data_and_ids(self):
        self.configure("grant")
        ids = (self.host.path("/etc/subuid").read_text(), self.host.path("/etc/subgid").read_text())
        self.host.path("/var/lib/paws-runner-docker/data").mkdir()
        self.host.log.write_text("")
        report = self.configure("deny")
        self.assertEqual((report["status"], report["changed"]), ("declined", True))
        self.assertFalse(self.host.path("/etc/systemd/system/paws-docker.service").exists())
        self.assertTrue(self.host.path("/var/lib/paws-runner-docker/data").is_dir())
        self.assertEqual((self.host.path("/etc/subuid").read_text(), self.host.path("/etc/subgid").read_text()), ids)
        self.assertEqual(self.host.commands(), ["systemctl disable --now -- paws-docker.service", "systemctl daemon-reload"])
        self.host.log.write_text("")
        again = self.configure("deny")
        self.assertEqual((again["status"], again["changed"], self.host.commands()), ("declined", False, []))

    def test_without_a_choice_an_existing_setup_stays_and_a_new_host_gets_nothing(self):
        before = self.host.snapshot()
        report = self.configure(None)
        self.assertEqual((report["status"], report["changed"]), ("opt-in-required", False))
        self.assertIn("PAWS_RUNNER_DOCKER_ACCESS=grant dpkg-reconfigure paws-runner", report["message"])
        self.assertEqual((self.host.snapshot(), self.host.commands()), (before, []))
        self.configure("grant")
        self.assertEqual(self.configure(None)["status"], "ready")
        self.assertTrue(self.host.path("/etc/systemd/system/paws-docker.service").exists())

    def test_a_host_without_docker_engine_gets_no_daemon(self):
        self.configure("grant")
        (self.host.bin / "dockerd").unlink()
        report = self.configure("grant")
        self.assertEqual((report["status"], report["changed"]), ("absent", True))
        self.assertFalse(self.host.path("/etc/systemd/system/paws-docker.service").exists())
        self.assertTrue(self.host.path("/var/lib/paws-runner-docker").is_dir())

    def test_an_upgrade_removes_the_docker_group_membership_paws_recorded_adding(self):
        host = FakeDockerHost(self.installer, pathlib.Path(self.temporary.name) / "recorded", members=["pascal", "paws-runner"])
        self.host = host
        self.validate()
        host.path("/state/docker-group.json").write_text(json.dumps({"added": True}))
        report = self.configure(None, host)
        self.assertEqual((report["dockerGroup"]["status"], report["dockerGroup"]["changed"]), ("group-removed", True))
        self.assertIn("Removed paws-runner from the docker group", report["dockerGroup"]["message"])
        self.assertEqual(host.commands(), ["gpasswd -d paws-runner docker"])
        self.assertEqual(host.members.read_text().split(), ["pascal"])
        self.assertFalse(host.path("/state/docker-group.json").exists())
        self.assertNotIn("dockerGroup", self.configure(None, host))

    def test_an_unrecorded_docker_group_membership_is_left_alone_with_a_warning(self):
        host = FakeDockerHost(self.installer, pathlib.Path(self.temporary.name) / "unrecorded", members=["paws-runner"])
        self.host = host
        self.validate()
        report = self.configure("grant", host)
        self.assertEqual(report["status"], "granted")
        self.assertEqual((report["dockerGroup"]["status"], report["dockerGroup"]["changed"]), ("group-kept", False))
        self.assertIn(self.installer.DOCKER_RISK, report["dockerGroup"]["message"])
        self.assertFalse(any(command.startswith("gpasswd") for command in host.commands()))
        self.assertEqual(host.members.read_text().split(), ["paws-runner"])

    def test_identity_validation_still_rejects_other_groups(self):
        self.host.members.write_text("paws-runner\npaws-agent\n")
        with self.assertRaisesRegex(ValueError, "unrelated supplemental group"):
            self.validate()
        self.host.members.write_text("paws-runner\n")
        self.host.groups["sudo"][1].append("paws-runner")
        with self.assertRaisesRegex(ValueError, "unrelated supplemental group"):
            self.validate()

    def test_the_vendored_launcher_is_checked_against_its_pinned_sha256(self):
        vendored = pathlib.Path(sys.argv[1]).with_name("dockerd-rootless.sh").read_bytes()
        self.assertEqual(release.verify_dockerd_rootless(vendored), vendored)
        self.assertEqual(hashlib.sha256(vendored).hexdigest(), release.DOCKERD_ROOTLESS_SHA256)
        package = load("deb-package")
        source = pathlib.Path(self.temporary.name) / "source"
        source.mkdir()
        (source / "dockerd-rootless.sh").write_bytes(vendored + b"# changed\n")
        output = pathlib.Path(self.temporary.name) / "output"
        with mock.patch.object(package, "ROOT", source), mock.patch.object(package.release, "verify_release", lambda arguments, root: self.fail("packaged with a changed launcher")):
            with self.assertRaisesRegex(ValueError, "dockerd-rootless.sh checksum mismatch"):
                package.build(SimpleNamespace(output=str(output)))
        self.assertFalse(output.exists())
        self.host.path("/usr/lib/paws-runner-package/dockerd-rootless.sh").write_bytes(vendored + b"# changed\n")
        report = self.configure("grant")
        self.assertEqual(report["status"], "missing-launcher")
        self.assertFalse(self.host.path("/etc/systemd/system/paws-docker.service").exists())

    def test_postrm_remove_and_purge_clean_up_rootless_docker(self):
        package = load("deb-package")
        units = sorted(name for name in release.ASSETS if name.endswith((".service", ".socket", ".path")))
        for action in ("remove", "purge"):
            root = pathlib.Path(self.temporary.name) / action
            log = root / "systemctl.log"
            (root / "bin").mkdir(parents=True)
            (root / "bin/systemctl").write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> {shlex.quote(str(log))}\n')
            (root / "bin/systemctl").chmod(0o755)
            for name in ("etc/systemd/system/paws-docker.service", "var/lib/paws-runner-docker/data/image"):
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text("x")
            (root / "etc/subuid").write_text("pascal:100000:65536\npaws-runner:165536:65536\n")
            (root / "etc/subgid").write_text("paws-runner:100000:65536\npascal:165536:65536\n")
            script = root / "postrm"
            script.write_text(package.postrm(units, str(root)))
            run = lambda argument: subprocess.run(["/bin/sh", str(script), argument], env={"PATH": f"{root / 'bin'}:/usr/bin:/bin", "LANG": "C"}, capture_output=True, timeout=30)
            # dpkg runs postrm remove, then postrm purge.
            for argument in ("remove", "purge") if action == "purge" else ("remove",):
                result = run(argument)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertFalse((root / "etc/systemd/system/paws-docker.service").exists())
            self.assertIn("disable --now -- paws-docker.service", log.read_text().splitlines())
            self.assertIn("daemon-reload", log.read_text().splitlines())
            if action == "remove":
                self.assertTrue((root / "var/lib/paws-runner-docker/data/image").exists())
                self.assertEqual((root / "etc/subuid").read_text(), "pascal:100000:65536\npaws-runner:165536:65536\n")
                self.assertEqual((root / "etc/subgid").read_text(), "paws-runner:100000:65536\npascal:165536:65536\n")
            else:
                self.assertFalse((root / "var/lib/paws-runner-docker").exists())
                self.assertEqual((root / "etc/subuid").read_text(), "pascal:100000:65536\n")
                self.assertEqual((root / "etc/subgid").read_text(), "pascal:165536:65536\n")

    def test_subordinate_ranges_start_on_a_65536_boundary_past_the_highest_range(self):
        start = self.installer.next_subordinate_start
        self.assertEqual(start(""), 100000)
        self.assertEqual(start("# comment\n\n"), 100000)
        self.assertEqual(start("pascal:100000:65536\n"), 196608)
        self.assertEqual(start("a:65536:65536\nb:0:10\n"), 131072)
        self.assertEqual(start("a:200000:1\nb:100000:65536\n"), 262144)

    def test_choice_comes_from_the_environment_and_never_prompts(self):
        self.assertIsNone(self.installer.docker_access_choice({}))
        self.assertEqual(self.installer.docker_access_choice({"PAWS_RUNNER_DOCKER_ACCESS": "grant"}), "grant")
        self.assertEqual(self.installer.docker_access_choice({"PAWS_RUNNER_DOCKER_ACCESS": "deny"}), "deny")
        with self.assertRaisesRegex(ValueError, "grant or deny"):
            self.installer.docker_access_choice({"PAWS_RUNNER_DOCKER_ACCESS": "yes"})

    def test_the_probe_tells_docker_engine_apart_from_other_answers(self):
        directory = pathlib.Path(self.temporary.name)
        def probe(response):
            path = directory / "daemon.sock"
            path.unlink(missing_ok=True)
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(path))
            server.listen(1)
            def serve():
                connection, _ = server.accept()
                connection.recv(4096)
                connection.sendall(response)
                connection.close()
            thread = threading.Thread(target=serve)
            thread.start()
            try:
                return subprocess.run([sys.executable, "-I", "-B", "-c", self.installer.DOCKER_PROBE, str(path)], capture_output=True, timeout=30).stdout.decode().strip()
            finally:
                thread.join(10)
                server.close()
        engine = json.dumps({"Platform": {"Name": "Docker Engine - Community"}, "Components": [{"Name": "Engine", "Version": "29.1.3"}]}).encode()
        podman = json.dumps({"Components": [{"Name": "Podman Engine", "Version": "5.0.3"}]}).encode()
        self.assertEqual(probe(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n" + engine), "ready")
        self.assertEqual(probe(b"HTTP/1.0 200 OK\r\n\r\n" + podman), "alternative-runtime")
        self.assertEqual(probe(b"HTTP/1.0 500 Internal Server Error\r\n\r\n"), "daemon-unavailable")
        missing = subprocess.run([sys.executable, "-I", "-B", "-c", self.installer.DOCKER_PROBE, str(directory / "absent.sock")], capture_output=True, timeout=30)
        self.assertEqual(missing.stdout.decode().strip(), "daemon-unavailable")

    def test_package_configuration_sets_docker_access_before_the_runner_starts(self):
        deb = load("deb-control")
        order = []
        state = pathlib.Path(self.temporary.name) / "debian-services.json"
        installer = deb.installer
        def command(arguments):
            order.append(("systemctl", *arguments[1:]))
            return b""
        def configure_docker_access(choice):
            order.append(("docker", choice))
            return {"status": "granted", "changed": True, "message": "Set up"}
        patches = [
            mock.patch.object(deb, "RESTART", state),
            mock.patch.object(deb, "active_services", lambda: ["paws-runner.service"]),
            mock.patch.object(deb, "enabled_services", lambda: []),
            mock.patch.object(installer, "write_atomic", lambda path, content, mode: path.write_bytes(content)),
            mock.patch.object(installer.release, "verify_release", lambda arguments, root: ({"version": "1.0.0"}, None, "key")),
            mock.patch.object(installer.release, "command", command),
            mock.patch.object(installer, "prepare_agents", lambda artifact: order.append(("prepare_agents",))),
            mock.patch.object(installer, "install", fake_install(order)),
            mock.patch.object(installer, "finish_agents", lambda agents: order.append(("finish_agents",)) or {}),
            mock.patch.object(installer, "prune", lambda: {"removed": []}),
            mock.patch.object(installer, "configure_docker_access", configure_docker_access),
            mock.patch.dict(os.environ, {"PAWS_RUNNER_DOCKER_ACCESS": "grant"}),
        ]
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            deb.configure()
        self.assertEqual(order[:5], [("prepare_agents",), ("install",), ("finish_agents",), ("docker", "grant"), ("systemctl", "start", "--", "paws-runner.service")])
        with mock.patch.dict(os.environ, {"PAWS_RUNNER_DOCKER_ACCESS": "maybe"}), mock.patch.object(installer.release, "verify_release", lambda arguments, root: self.fail("configured with an invalid choice")):
            with self.assertRaisesRegex(ValueError, "grant or deny"):
                deb.configure()


class StateDirectories(unittest.TestCase):
    IDS = {"paws-runner": 60980, "paws-agent": 60979, "paws-results": 60981}

    def setUp(self):
        self.installer = load("install")
        self.temporary = tempfile.TemporaryDirectory(prefix="paws-state-directories-")
        self.root = pathlib.Path(self.temporary.name)
        self.gids = dict(self.IDS)
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(mock.patch.object(self.installer.pwd, "getpwnam", lambda name: SimpleNamespace(pw_uid=self.IDS[name])))
        self.stack.enter_context(mock.patch.object(self.installer.grp, "getgrnam", lambda name: SimpleNamespace(gr_gid=self.gids[name])))
        self.layout = {path: SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=self.IDS[owner], st_gid=self.IDS[group]) for path, owner, group, mode in self.installer.STATE_DIRECTORIES}

    def tearDown(self):
        self.stack.close()
        self.temporary.cleanup()

    def validate(self):
        self.installer.validate_state_directories(lambda path: self.layout[path])

    def test_tmpfiles_creates_what_the_installer_validates(self):
        tmpfiles = pathlib.Path(sys.argv[1]).with_name("paws-runner.tmpfiles").read_text().splitlines()
        created = [(path, owner, group, int(mode, 8)) for kind, path, mode, owner, group, _ in (line.split() for line in tmpfiles) if kind == "d" and path.startswith("/var/lib/")]
        self.assertEqual(created, list(self.installer.STATE_DIRECTORIES))

    def test_shared_trees_belong_to_the_runner_and_reach_agents_through_a_group(self):
        shared = {path: (owner, group, mode) for path, owner, group, mode in self.installer.STATE_DIRECTORIES if path in self.installer.SHARED_DIRECTORIES}
        self.assertEqual(shared, {
            "/var/lib/paws-agent": ("paws-runner", "paws-agent", 0o2770),
            "/var/lib/paws-agent-tasks": ("paws-runner", "paws-agent", 0o2770),
            "/var/lib/paws-agent-results": ("paws-runner", "paws-results", 0o2770),
        })
        self.validate()

    def test_validation_refuses_the_earlier_private_layout_and_other_access(self):
        for path, mode in (("/var/lib/paws-agent", 0o700), ("/var/lib/paws-agent-tasks", 0o711), ("/var/lib/paws-agent-results", 0o750), ("/var/lib/paws-agent", 0o2777), ("/var/lib/paws-agent", 0o770)):
            with self.subTest(path=path, mode=oct(mode)):
                before = self.layout[path]
                self.layout[path] = SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=before.st_uid, st_gid=before.st_gid)
                try:
                    with self.assertRaisesRegex(ValueError, path):
                        self.validate()
                finally:
                    self.layout[path] = before

    def test_validation_refuses_a_tree_outside_the_agent_group(self):
        self.gids["paws-agent"] = 60990
        with self.assertRaisesRegex(ValueError, "/var/lib/paws-agent$"):
            self.validate()

    def test_an_upgrade_adopts_earlier_trees_group_shared_with_setgid_only_on_the_roots(self):
        for name in ("agent/.paws-accounts/binding/.claude", "results/01K00000000000000000000000"):
            (self.root / name).mkdir(parents=True, mode=0o700)
        (self.root / "results/01K00000000000000000000000").chmod(0o750)
        (self.root / "agent/.paws-accounts/binding/account.json").write_text("{}")
        (self.root / "agent/.paws-accounts/binding/account.json").chmod(0o600)
        modes, owners = {}, {}
        with mock.patch.object(self.installer.os, "chmod", lambda path, mode: modes.__setitem__(str(pathlib.Path(path).relative_to(self.root)), mode)), mock.patch.object(self.installer.os, "lchown", lambda path, uid, gid: owners.__setitem__(str(pathlib.Path(path).relative_to(self.root)), (uid, gid))):
            self.installer.adopt_tree(self.root / "agent", 60980, 60979, 0o2770, self.installer.SHARED_DIRECTORIES["/var/lib/paws-agent"])
            self.installer.adopt_tree(self.root / "results", 60980, 60981, 0o2770, self.installer.SHARED_DIRECTORIES["/var/lib/paws-agent-results"])
        self.assertEqual(modes, {
            "agent": 0o2770,
            "agent/.paws-accounts": 0o770,
            "agent/.paws-accounts/binding": 0o770,
            "agent/.paws-accounts/binding/.claude": 0o770,
            "results": 0o2770,
            "results/01K00000000000000000000000": 0o750,
        })
        self.assertEqual(owners["agent/.paws-accounts/binding/account.json"], (60980, 60979))
        self.assertEqual(owners["results/01K00000000000000000000000"], (60980, 60981))


class FakeSystemctl:
    """systemctl and the release's Bun for install(): records every call; `active` lists running executions."""

    def __init__(self):
        self.calls = []
        self.active = b""
        self.broken = False

    def __call__(self, arguments):
        if arguments[0] != "/usr/bin/systemctl":
            return release.BUN_VERSION.encode() if arguments[1:] == ["--version"] else b""
        self.calls.append(tuple(arguments[1:]))
        if self.broken:
            raise ValueError("Required command failed: /usr/bin/systemctl")
        if arguments[1] == "list-units":
            return self.active
        if arguments[1] == "list-unit-files":
            return b"paws-runner.service enabled\n"
        return b""

    def verbs(self):
        return [call[0] for call in self.calls]


PREINST_CONTROL = """import importlib.util, os, pathlib
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("deb_control", {deb_control!r})
deb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deb)
deb.ROOT = pathlib.Path(__file__).parent
deb.installer.STATE = pathlib.Path({state!r})
# Only root can own the record outside a namespace; admitted_release insists on it.
pathlib.Path.lstat = lambda path: SimpleNamespace(st_uid=0, st_mode=os.lstat(path).st_mode)
deb.main()
"""


class RunnerUpgrade(unittest.TestCase):
    """deb-control.py configure against a temp root and a fake systemctl."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="paws-runner-upgrade-")
        self.root = pathlib.Path(self.temporary.name)
        self.deb = load("deb-control")
        self.installer = self.deb.installer
        self.base = self.root / "opt/paws-runner"
        self.state = self.root / "state"
        self.state.mkdir()
        (self.base / "releases/1.2.2").mkdir(parents=True)
        (self.base / "current").symlink_to(self.base / "releases/1.2.2")
        self.artifact = self.root / "artifact.tar"
        with tarfile.open(self.artifact, "w") as archive:
            for name in sorted(release.REQUIRED):
                member = tarfile.TarInfo(name)
                content = release.RUNNER_LAUNCHER if name == "bin/paws-runner" else b"synthetic reviewed release file"
                member.size = len(content)
                member.mode = 0o755 if name in release.BINARIES else 0o644
                archive.addfile(member, io.BytesIO(content))
        self.systemctl = FakeSystemctl()
        self.order = []
        self.syncs = []

    def tearDown(self):
        self.temporary.cleanup()

    def record(self, step, result=None):
        def call(*arguments, **options):
            self.order.append(step)
            return result
        return call

    def preinst(self, installed, incoming, action="upgrade"):
        """Run the package's preinst as dpkg does, from a folder of control files, with `installed` recorded."""
        host = self.root / "host"
        state = host / "var/lib/paws-runner-install"
        control = self.root / "control"
        state.mkdir(parents=True, exist_ok=True)
        control.mkdir(exist_ok=True)
        (control / "deb-control.py").write_text(PREINST_CONTROL.format(deb_control=str(pathlib.Path(sys.argv[1]).with_name("deb-control.py")), state=str(state)))
        (control / "preinst").write_text(load("deb-package").preinst(str(host)))
        (state / "release.json").unlink(missing_ok=True)
        if installed is not None:
            (state / "release.json").write_text(json.dumps({"status": "installed", "releaseKeyFingerprint": "key", **installed}))
            (state / "release.json").chmod(0o600)
        (control / "admission.json").write_text(json.dumps({"releaseKeyFingerprint": "key", **incoming}))
        return subprocess.run(["/bin/sh", str(control / "preinst"), action, "0.1.75"], env={"PATH": "/usr/bin:/bin", "LANG": "C"}, capture_output=True, timeout=30)

    def test_preinst_refuses_an_older_package_before_dpkg_unpacks_it(self):
        result = self.preinst({"version": "0.1.75", "artifactSha256": "new"}, {"version": "0.1.73", "artifactSha256": "old"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.decode().strip(), "Release version must advance the installed version")

    def test_preinst_admits_the_same_artifact_and_a_newer_version_and_refuses_another_artifact_of_the_same_version(self):
        installed = {"version": "0.1.75", "artifactSha256": "same"}
        for incoming in (installed, {"version": "0.1.76", "artifactSha256": "next"}):
            result = self.preinst(installed, incoming)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertNotEqual(self.preinst(installed, {"version": "0.1.75", "artifactSha256": "other"}).returncode, 0)

    def test_preinst_checks_only_an_install_or_upgrade_with_a_recorded_release(self):
        older = {"version": "0.1.73", "artifactSha256": "old"}
        self.assertEqual(self.preinst({"version": "0.1.75", "artifactSha256": "new"}, older, "abort-upgrade").returncode, 0)
        self.assertEqual(self.preinst(None, older, "install").returncode, 0)

    def test_the_package_carries_what_preinst_needs_in_its_control_files(self):
        package = load("deb-package")
        manifest = {"version": "0.1.75", "platform": "linux-x64", "artifactSha256": "digest"}
        built = {}

        def verified(arguments, staging):
            for name in ("manifest.json", "manifest.sig", "release.pub"):
                (staging / name).write_text("x")
            return manifest, self.artifact, "fingerprint"

        def dpkg_deb(command, **options):
            control = pathlib.Path(command[-2]) / "DEBIAN"
            built.update({path.name: path.read_text() for path in control.iterdir()})
            pathlib.Path(command[-1]).write_bytes(b"deb")

        with mock.patch.object(package.release, "verify_release", verified), mock.patch.object(package.subprocess, "run", dpkg_deb):
            package.build(SimpleNamespace(output=str(self.root / "output")))
        self.assertEqual(built["preinst"], package.preinst())
        self.assertEqual(json.loads(built["admission.json"]), {"version": "0.1.75", "artifactSha256": "digest", "releaseKeyFingerprint": "fingerprint"})
        deploy = pathlib.Path(sys.argv[1]).parent
        for name in ("deb-control.py", "install.py", "release.py"):
            self.assertEqual(built[name], (deploy / name).read_text())

    def switch(self, unpacked, destination, pointers):
        self.order.append("switch")
        pending = self.base / ".current-pending"
        pending.symlink_to(destination)
        os.replace(pending, self.base / "current")

    def patches(self, prepare_agents):
        installer = self.installer
        stop = installer.stop_for_install
        return [
            mock.patch.object(installer, "BASE", self.base),
            mock.patch.object(installer, "STATE", self.state),
            mock.patch.object(self.deb, "RESTART", self.state / "debian-services.json"),
            mock.patch.object(self.deb, "active_services", lambda: ["paws-runner.service"]),
            mock.patch.object(self.deb, "enabled_services", lambda: ["paws-runner.service"]),
            mock.patch.object(installer, "root_directory", lambda path, mode=0o755: path.mkdir(parents=True, exist_ok=True)),
            mock.patch.object(installer, "lock_install", lambda: os.open(self.state / "install.lock", os.O_RDWR | os.O_CREAT, 0o600)),
            mock.patch.object(installer, "lock_agents", lambda: os.open(self.state / "agents.lock", os.O_RDWR | os.O_CREAT, 0o600)),
            mock.patch.object(installer, "prerequisites", lambda: None),
            mock.patch.object(installer.release, "verify_release", lambda arguments, root: ({"version": "1.2.3", "platform": "linux-x64", "artifactSha256": "0" * 64}, self.artifact, "key")),
            mock.patch.object(installer.release, "verify_mise", lambda content, platform: None),
            mock.patch.object(installer.release, "command", self.systemctl),
            mock.patch.object(installer, "sync_filesystem", lambda path: self.syncs.append(path) or self.order.append("sync")),
            mock.patch.object(installer, "prepare_agents", prepare_agents),
            mock.patch.object(installer, "stop_for_install", lambda: self.order.append("stop") or stop()),
            mock.patch.object(installer, "switch_release", self.switch),
            mock.patch.object(installer, "finish_agents", self.record("finish_agents", {})),
            mock.patch.object(installer, "configure_docker_access", self.record("docker", {"status": "absent"})),
            mock.patch.object(installer.shutil, "rmtree", self.contained(installer.shutil.rmtree)),
            # Python 3.14 cleans temporary directories through shutil.rmtree, so configure's own
            # temporary directory must live under the test root too.
            mock.patch.object(tempfile, "tempdir", str(self.root)),
        ]

    def contained(self, rmtree):
        """rmtree that refuses anything outside the temp root, so a missed patch can't reach the host's runner."""
        def remove(path, *arguments, **options):
            if not pathlib.Path(path).is_relative_to(self.root):
                raise AssertionError(f"removing {path} outside the test root")
            return rmtree(path, *arguments, **options)
        return remove

    def configure(self, prepare_agents):
        errors = io.StringIO()
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            for patch in self.patches(prepare_agents):
                stack.enter_context(patch)
            stack.enter_context(contextlib.redirect_stderr(errors))
            stack.enter_context(contextlib.redirect_stdout(output))
            try:
                self.deb.configure()
            finally:
                self.journal = [json.loads(line) for line in errors.getvalue().splitlines() if line.startswith('{"event": "runner_upgrade_phase"')]
        return json.loads(output.getvalue().strip().splitlines()[-1])

    def test_the_runner_stops_only_after_the_release_is_extracted_and_the_agents_are_prepared(self):
        def prepare_agents(artifact):
            # The new release is complete beside the running one, which still runs from current.
            self.assertTrue((self.base / "releases/1.2.3/src/runner-cli/main.ts").is_file())
            self.assertEqual((self.base / "releases/1.2.3/bin/paws-runner").read_bytes(), release.RUNNER_LAUNCHER)
            self.assertEqual(os.readlink(self.base / "current"), str(self.base / "releases/1.2.2"))
            self.assertNotIn("stop", self.systemctl.verbs())
            self.order.append("prepare_agents")
            return {"agents": {}}
        installed = self.configure(prepare_agents)
        self.assertEqual(self.order, ["sync", "prepare_agents", "stop", "switch", "finish_agents", "docker"])
        self.assertEqual(self.syncs, [self.base / "releases/1.2.3"])
        self.assertEqual(os.readlink(self.base / "current"), str(self.base / "releases/1.2.3"))
        verbs = self.systemctl.verbs()
        self.assertLess(verbs.index("stop"), verbs.index("start"))
        self.assertEqual(self.systemctl.calls[verbs.index("start")], ("start", "--", "paws-runner.service"))
        self.assertEqual(installed["pruned"], {"removed": []})
        self.assertEqual([line["phase"] for line in self.journal], ["verify", "extract", "agents", "stop-to-start", "prune"])
        self.assertTrue(all(isinstance(line["seconds"], float) for line in self.journal))
        self.assertFalse((self.state / "debian-services.json").exists())

    def test_the_agent_tools_folder_points_at_the_current_release_and_switches_with_it(self):
        agent_bin = self.base / "agent-bin"
        def prepare_agents(artifact):
            # In place before the stop, still naming the running release.
            self.assertEqual(os.readlink(agent_bin), "current/agent-bin")
            self.assertEqual(agent_bin.resolve(), self.base / "releases/1.2.2/agent-bin")
            self.assertEqual(sorted(path.name for path in (self.base / "releases/1.2.3/agent-bin").iterdir()), ["gh"])
            self.assertEqual((self.base / "releases/1.2.3/agent-bin/gh").stat().st_mode & 0o7777, 0o755)
            return {"agents": {}}
        self.configure(prepare_agents)
        self.assertEqual(os.readlink(agent_bin), "current/agent-bin")
        self.assertEqual(agent_bin.resolve(), self.base / "releases/1.2.3/agent-bin")
        self.assertEqual((agent_bin / "gh").read_bytes(), b"synthetic reviewed release file")

    def test_an_agent_tools_folder_that_is_not_the_release_pointer_stops_the_upgrade(self):
        for make in (lambda path: path.symlink_to(self.root), lambda path: path.symlink_to("current/bin"), lambda path: path.mkdir()):
            with self.subTest():
                agent_bin = self.base / "agent-bin"
                make(agent_bin)
                self.systemctl.calls.clear()
                with self.assertRaisesRegex(ValueError, "Unsafe agent tools pointer"):
                    self.configure(lambda artifact: {"agents": {}})
                self.assertNotIn("stop", self.systemctl.verbs())
                self.assertEqual(os.readlink(self.base / "current"), str(self.base / "releases/1.2.2"))
                agent_bin.rmdir() if agent_bin.is_dir() and not agent_bin.is_symlink() else agent_bin.unlink()

    def test_a_failing_agent_preparation_leaves_the_runner_running_on_its_release(self):
        def prepare_agents(artifact):
            raise self.installer.AgentInstallError("codex", "2.5.0", "bun install exited 1")
        with self.assertRaisesRegex(ValueError, "codex 2.5.0 was not installed"):
            self.configure(prepare_agents)
        self.assertNotIn("stop", self.systemctl.verbs())
        self.assertNotIn("start", self.systemctl.verbs())
        self.assertEqual(os.readlink(self.base / "current"), str(self.base / "releases/1.2.2"))
        self.assertFalse((self.state / "release.json").exists())
        self.assertEqual([line["phase"] for line in self.journal], ["verify", "extract"])

    def test_the_package_upgrade_step_checks_but_leaves_the_runner_running(self):
        manifest = self.root / "manifest.json"
        manifest.write_text(json.dumps({"format": 1, "version": "1.2.2", "platform": "linux-x64", "bunVersion": release.BUN_VERSION, "artifactSha256": "0" * 64}))
        with mock.patch.object(self.deb, "ROOT", self.root), mock.patch.object(self.deb.installer.release, "parse_manifest", lambda content: json.loads(content)), mock.patch.object(self.deb, "RESTART", self.state / "debian-services.json"), mock.patch.object(self.deb, "active_services", lambda: ["paws-runner.service"]), mock.patch.object(self.installer, "write_atomic", lambda path, content, mode: path.write_bytes(content)), mock.patch.object(self.installer.release, "command", self.systemctl):
            self.deb.stop("1.2.3")
            self.assertEqual(self.systemctl.verbs(), ["list-units"])
            with self.assertRaisesRegex(ValueError, "downgrades"):
                self.deb.stop("1.2.1")
            self.systemctl.active = b"paws-agent@01K00000000000000000000000.service loaded active running\n"
            with self.assertRaisesRegex(ValueError, "Active agent executions"):
                self.deb.stop("1.2.3")
            # Removing the package still stops the runner first.
            self.systemctl.active = b""
            self.systemctl.calls.clear()
            self.deb.stop(None)
            self.assertIn(("stop", "--", "paws-runner.service"), self.systemctl.calls)

    def test_extraction_syncs_no_file_and_sync_filesystem_flushes_once(self):
        destination = self.root / "extracted"
        destination.mkdir()
        with mock.patch.object(os, "fsync", side_effect=AssertionError("fsync during extraction")) as fsync:
            self.installer.extract_verified(self.artifact, destination)
        self.assertEqual(fsync.call_count, 0)
        self.assertEqual((destination / "bin/paws-runner").read_bytes(), release.RUNNER_LAUNCHER)
        # The real syncfs(2), on the temp root's filesystem.
        self.installer.sync_filesystem(destination)

    def tree(self, folder, versions, current):
        for version in versions:
            (folder / version / "bin").mkdir(parents=True)
            (folder / version / "bin/run").write_text(version)
        if current is not None:
            (folder / "current").symlink_to(current)

    def prune(self):
        with mock.patch.object(self.installer.shutil, "rmtree", self.contained(self.installer.shutil.rmtree)), mock.patch.object(self.installer.release, "command", self.systemctl), mock.patch.object(self.installer, "lock_agents", lambda: os.open(self.state / "agents.lock", os.O_RDWR | os.O_CREAT, 0o600)):
            return self.installer.prune(self.base)

    def test_pruning_keeps_the_current_and_previous_versions_and_skips_one_in_use(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "keep").write_text("not Paws")
        releases = self.base / "releases"
        # setUp made 1.2.2, the release before 1.2.3.
        self.tree(releases, ["1.0.0", "1.1.0", "1.2.3"], None)
        (releases / "1.0.0/link").symlink_to(outside)
        (releases / "0.9.0").symlink_to(outside)
        (self.base / "current").unlink()
        (self.base / "current").symlink_to(releases / "1.2.3")
        claude = self.base / "agents/claude"
        self.tree(claude, ["0.88.0", "0.90.0", "0.95.0", "0.99.1", "1.0.0"], "0.99.1")
        codex = self.base / "agents/codex"
        self.tree(codex, ["2.1.1", "2.5.0"], "2.5.0")
        (self.base / "agents/grok").symlink_to(outside)
        # A launcher's shared lock marks 0.88.0 in use.
        holder = os.open(claude / "0.88.0", os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, holder)
        fcntl.flock(holder, fcntl.LOCK_SH)
        result = self.prune()
        self.assertEqual(sorted(result["removed"]), sorted(str(path) for path in (releases / "1.0.0", releases / "1.1.0", claude / "0.90.0")))
        self.assertEqual(sorted(path.name for path in releases.iterdir()), ["0.9.0", "1.2.2", "1.2.3"])
        self.assertEqual(sorted(path.name for path in claude.iterdir()), ["0.88.0", "0.95.0", "0.99.1", "1.0.0", "current"])
        self.assertEqual(sorted(path.name for path in codex.iterdir()), ["2.1.1", "2.5.0", "current"])
        self.assertEqual((outside / "keep").read_text(), "not Paws")
        self.assertEqual(self.systemctl.verbs(), ["list-units"])

    def test_pruning_removes_nothing_while_an_execution_runs_or_when_its_state_is_unreadable(self):
        claude = self.base / "agents/claude"
        self.tree(claude, ["0.88.0", "0.90.0", "0.99.1"], "0.99.1")
        self.systemctl.active = b"paws-check@01K00000000000000000000000.service loaded active running\n"
        self.assertEqual(self.prune(), {"skipped": "an execution is running"})
        self.systemctl.active = b""
        self.systemctl.broken = True
        self.assertEqual(self.prune(), {"skipped": "the execution state is unreadable"})
        self.assertEqual(sorted(path.name for path in claude.iterdir()), ["0.88.0", "0.90.0", "0.99.1", "current"])
        self.assertEqual(sorted(path.name for path in (self.base / "releases").iterdir()), ["1.2.2"])


class AgentUnit(unittest.TestCase):
    def setUp(self):
        self.installer = load("install")
        self.assets = pathlib.Path(sys.argv[1]).parent

    def unit(self, name):
        keys = {}
        for line in (self.assets / name).read_text().splitlines():
            if "=" in line and not line.startswith(("#", "[")):
                key, value = line.split("=", 1)
                keys.setdefault(key, []).append(value)
        return keys

    def test_the_polkit_rule_ships_and_installs_into_polkit_rules(self):
        self.assertIn("paws-runner.polkit", self.installer.release.ASSETS)
        self.assertEqual(self.installer.asset_target("paws-runner.polkit"), pathlib.Path("/etc/polkit-1/rules.d/50-paws-runner.rules"))
        self.assertEqual(self.installer.asset_target("paws-agent@.service"), pathlib.Path("/etc/systemd/system/paws-agent@.service"))
        rule = (self.assets / "paws-runner.polkit").read_text()
        for needed in ('"org.freedesktop.systemd1.manage-units"', 'subject.user !== "paws-runner"', 'verb === "start" || verb === "stop"', "^paws-agent@[0-7][0-9A-HJKMNP-TV-Z]{25}\\.service$"):
            self.assertIn(needed, rule)

    def test_tmpfiles_makes_the_agent_environment_directory(self):
        lines = (self.assets / "paws-runner.tmpfiles").read_text().splitlines()
        self.assertIn("d /run/paws-runner/agent 2750 paws-runner paws-agent -", lines)
        self.assertLess(lines.index("d /run/paws-runner 0755 root root -"), lines.index("d /run/paws-runner/agent 2750 paws-runner paws-agent -"))

    def test_the_agent_unit_takes_its_launch_from_the_runner(self):
        unit = self.unit("paws-agent@.service")
        self.assertEqual(unit["EnvironmentFile"], ["/run/paws-runner/agent/%i.env"])
        self.assertEqual(unit["ExecStart"], ["/opt/paws-runner/bin/paws-runner runner worker --execution-id %i $PAWS_RESUME"])
        self.assertEqual(unit["StandardOutput"], ["append:/run/paws-runner/agent/%i.log"])
        self.assertEqual(unit["StandardError"], unit["StandardOutput"])
        self.assertEqual(unit["UMask"], ["0007"])
        self.assertEqual(unit["User"], ["paws-agent"])
        self.assertEqual(unit["KillMode"], ["control-group"])
        self.assertIn("PAWS_AGENT_USER=paws-agent", unit["Environment"])
        self.assertNotIn("StateDirectory", unit)
        self.assertNotIn("StateDirectoryMode", unit)
        self.assertIn("-/run/paws-runner/agent", self.unit("paws-runner.service")["ReadWritePaths"])


class AgentUserDefault(unittest.TestCase):
    def setUp(self):
        self.installer = load("install")
        self.temporary = tempfile.TemporaryDirectory()
        self.config = pathlib.Path(self.temporary.name) / "config.json"
        patch = mock.patch.object(self.installer, "root_directory", lambda path, mode=0o755: None)
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(self.temporary.cleanup)

    def write(self, content):
        self.config.write_text(content)
        self.config.chmod(0o640)

    def test_a_fresh_install_writes_no_config_and_the_runner_defaults_to_paws_agent(self):
        self.assertFalse(self.installer.default_agent_user(self.config))
        self.assertFalse(self.config.exists())

    def test_an_upgrade_keeps_an_explicit_runner(self):
        self.write('{"concurrency": 2, "agentUser": "runner"}')
        self.assertFalse(self.installer.default_agent_user(self.config))
        self.assertEqual(self.config.read_text(), '{"concurrency": 2, "agentUser": "runner"}')

    def test_an_upgrade_without_the_key_adds_paws_agent_and_keeps_the_rest(self):
        self.write('{"controlPlaneUrl": "https://paws.example", "concurrency": 3}')
        before = self.config.stat()
        self.assertTrue(self.installer.default_agent_user(self.config))
        self.assertEqual(json.loads(self.config.read_text()), {"controlPlaneUrl": "https://paws.example", "concurrency": 3, "agentUser": "paws-agent"})
        after = self.config.stat()
        self.assertEqual((after.st_uid, after.st_gid, after.st_mode & 0o7777), (before.st_uid, before.st_gid, 0o640))
        self.assertFalse(self.installer.default_agent_user(self.config))

    def test_an_unreadable_config_is_left_for_the_runner_to_report(self):
        self.write("{not json")
        self.assertFalse(self.installer.default_agent_user(self.config))
        self.assertEqual(self.config.read_text(), "{not json")
        self.config.unlink()
        self.config.symlink_to(self.config.with_name("elsewhere.json"))
        self.config.with_name("elsewhere.json").write_text("{}")
        self.assertFalse(self.installer.default_agent_user(self.config))
        self.assertEqual(self.config.with_name("elsewhere.json").read_text(), "{}")


AGENT_HOME_FOLDERS = (".codex", ".claude", ".grok", ".bun/bin", ".config/opencode", ".local/share/opencode", ".cache/opencode", "work/acme-app", ".paws-skills/versions", ".paws-accounts/01JBINDINGA000000000000000/.codex")
AGENT_HOME_FILES = (".codex/auth.json", ".claude.json", ".config/opencode/opencode.json", "work/acme-app/README.md", ".paws-accounts/01JBINDINGA000000000000000/account.json", ".paws-accounts/01JBINDINGA000000000000000/.codex/auth.json")


def agent_home_fixture(home):
    """An agent home as an earlier install left it: paws-runner:paws-agent, files 0660, directories 2770 where the host allows setgid."""
    for name in AGENT_HOME_FOLDERS:
        (home / name).mkdir(parents=True)
    for name in AGENT_HOME_FILES:
        (home / name).write_text("{}")
        (home / name).chmod(0o660)
    for path in [home, *home.rglob("*")]:
        if path.is_dir():
            with contextlib.suppress(PermissionError):
                path.chmod(0o2770)
            if path.stat().st_mode & 0o2000 == 0:
                path.chmod(0o770)


class AgentStateHandover(unittest.TestCase):
    RUNNER, AGENT, AGENT_GROUP = 60980, 60978, 60979
    HANDED_OVER = (".codex", ".codex/auth.json", ".claude", ".claude.json", ".grok", ".bun", ".bun/bin", ".config/opencode/opencode.json", ".local/share/opencode", ".cache/opencode", ".paws-accounts/01JBINDINGA000000000000000/.codex/auth.json")
    KEPT = ("work", "work/acme-app/README.md", ".paws-skills/versions", ".paws-accounts", ".paws-accounts/01JBINDINGA000000000000000", ".paws-accounts/01JBINDINGA000000000000000/account.json")

    def setUp(self):
        self.installer = load("install")
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.home = self.root / "agent"
        agent_home_fixture(self.home)
        self.modes = {path: stat.S_IMODE(path.lstat().st_mode) for path in [self.home, *self.home.rglob("*")]}
        # Ownership is simulated: every entry starts as paws-runner:paws-agent, as `adopt_tree` leaves it.
        self.owners = {}

    def lstat(self, path):
        info = os.lstat(path)
        uid, gid = self.owners.get(pathlib.Path(path), (self.RUNNER, self.AGENT_GROUP))
        return SimpleNamespace(st_mode=info.st_mode, st_uid=uid, st_gid=gid)

    def install(self, agent_user):
        """What switch_release does to the agent home: adopt it for paws-runner, then hand agent state over."""
        config = self.root / "config.json"
        config.write_text(json.dumps({"agentUser": agent_user}))
        chmods = []
        state = self.installer.agent_state_to_hand_over(self.home, config)
        with mock.patch.object(self.installer.os, "lchown", lambda path, uid, gid: self.owners.__setitem__(pathlib.Path(path), (uid, gid))), mock.patch.object(self.installer.os, "chmod", lambda path, mode: chmods.append(pathlib.Path(path))):
            self.installer.adopt_tree(self.home, self.RUNNER, self.AGENT_GROUP, 0o2770, self.installer.group_shared, state)
            changed = self.installer.hand_over_agent_state(state, self.AGENT, self.AGENT, self.lstat, lambda path, uid, gid: self.owners.__setitem__(pathlib.Path(path), (uid, gid)))
        return changed, chmods

    def owner(self, name):
        return self.owners.get(self.home / name, (self.RUNNER, self.AGENT_GROUP))

    def test_paws_agent_gets_its_state_with_modes_kept_and_a_second_run_changes_nothing(self):
        changed, chmods = self.install("paws-agent")
        self.assertGreater(changed, len(self.HANDED_OVER))
        for name in self.HANDED_OVER:
            self.assertEqual(self.owner(name), (self.AGENT, self.AGENT), name)
            self.assertNotIn(self.home / name, chmods, name)
        for name in self.KEPT:
            self.assertEqual(self.owner(name), (self.RUNNER, self.AGENT_GROUP), name)
        self.assertEqual({path: stat.S_IMODE(path.lstat().st_mode) for path in self.modes}, self.modes)
        handed = dict(self.owners)
        changed, chmods = self.install("paws-agent")
        self.assertEqual(changed, 0)
        self.assertEqual(self.owners, handed)
        self.assertFalse({self.home / name for name in self.HANDED_OVER} & set(chmods))

    def test_runner_leaves_ownership_as_it_is(self):
        changed, _ = self.install("runner")
        self.assertEqual(changed, 0)
        self.assertEqual(set(self.owners.values()), {(self.RUNNER, self.AGENT_GROUP)})

    def test_a_missing_config_reads_as_paws_agent_and_an_unreadable_one_hands_nothing_over(self):
        self.assertIn(self.home / ".codex", self.installer.agent_state_to_hand_over(self.home, self.root / "missing.json"))
        (self.root / "broken.json").write_text("{not json")
        self.assertEqual(self.installer.agent_state_to_hand_over(self.home, self.root / "broken.json"), frozenset())


class AgentStateHandoverAsAgent(unittest.TestCase):
    """A real handover: needs root to chown, so it skips elsewhere, like the setgid tests."""

    AGENT, OTHER = 65534, 65533

    @unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "chown to another user needs root")
    def test_the_agent_user_can_chmod_its_handed_over_state(self):
        installer = load("install")
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            root.chmod(0o755)
            home = root / "agent"
            agent_home_fixture(home)
            for path in [home, *home.rglob("*")]:
                os.lchown(path, self.OTHER, self.AGENT)
            auth = home / ".codex/auth.json"
            self.assertNotEqual(self.chmod_as_agent(auth), 0)
            config = root / "config.json"
            config.write_text('{"agentUser": "paws-agent"}')
            modes = {path: stat.S_IMODE(path.lstat().st_mode) for path in home.rglob("*")}
            installer.hand_over_agent_state(installer.agent_state_to_hand_over(home, config), self.AGENT, self.AGENT)
            self.assertEqual({path: stat.S_IMODE(path.lstat().st_mode) for path in home.rglob("*")}, modes)
            self.assertEqual((home / "work").stat().st_uid, self.OTHER)
            self.assertEqual(self.chmod_as_agent(auth), 0)
            self.assertEqual(stat.S_IMODE(auth.stat().st_mode), 0o600)

    def chmod_as_agent(self, path):
        child = os.fork()
        if child == 0:
            try:
                os.setgroups([])
                os.setgid(self.AGENT)
                os.setuid(self.AGENT)
                os.chmod(path, 0o600)
                os._exit(0)
            except OSError:
                os._exit(1)
        return os.waitstatus_to_exitcode(os.waitpid(child, 0)[1])


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *sys.argv[2:]], verbosity=2)
