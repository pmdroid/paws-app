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
        (production / ".bin").mkdir(exist_ok=True)
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
        self.assertFalse(any(name.startswith("app/node_modules/@agentclientprotocol/claude-agent-acp/") for name in members))
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
        arguments = argparse.Namespace(source=source, bun=runtime, version="1.2.3", platform={"x86_64":"linux-x64","aarch64":"linux-arm64"}[platform.machine()], output=self.root / "package-agent-pins", mise=None)
        with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.2\n")), mock.patch.object(packager, "install_production", return_value=source / "node_modules"):
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
            for name in sorted(release.REQUIRED | {"app/node_modules/yaml/package.json", "app/node_modules/.bin/yaml"}):
                member = tarfile.TarInfo(name)
                content = b"synthetic reviewed release file"
                member.size = len(content)
                member.mode = 0o755 if name in release.BINARIES else 0o644
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
        arguments = argparse.Namespace(source=source, bun=pathlib.Path(BUN), version="1.2.3", platform={"x86_64": "linux-x64", "aarch64": "linux-arm64"}[platform.machine()], output=output, mise=None)
        if subprocess.run([BUN, "--version"], capture_output=True, check=True).stdout.decode().strip() != release.BUN_VERSION:
            self.skipTest("the pinned Bun version is required")
        with mock.patch.object(packager, "install_production", return_value=source / "node_modules"), mock.patch.object(packager.release, "download_mise", return_value=b"\x7fELFsynthetic-mise"):
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
        expected = {"claude-agent-acp": "claude-agent-acp", "claude": "claude", "codex-acp": "codex-acp", "codex": "codex", "grok": "grok"}
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
        self.assertEqual(len(calls), 3)

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


    def published_integrity(self, agent, version):
        return self.registry.packuments[release.AGENT_PACKAGES[agent]]["versions"][version]["dist"]["integrity"]

    def request(self, agent, version, request_id, integrity=True, native=None, packages=None):
        """A request as Paws sends it: the catalog's integrity for the agent and for its native build package."""
        name = release.AGENT_NATIVE_PACKAGE[agent]
        if packages is None:
            published = self.registry.packuments.get(name, {}).get("versions", {}).get(native)
            packages = [{"name": name, "version": native, "integrity": published["dist"]["integrity"] if published else "sha512-" + "Q" * 86 + "=="}] if native is not None and name != release.AGENT_PACKAGES[agent] and integrity is not None else []
        return {"id": request_id, "agent": agent, "version": version, "integrity": self.published_integrity(agent, version) if integrity is True else integrity, "nativeVersion": native, "packages": packages}

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
        self.assertEqual(status["agents"]["codex"], {"current": "2.0.0", "previous": "1.0.0", "request": {"id": "update-1", "version": "2.0.0", "status": "installed"}})
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

    def test_a_native_package_with_bytes_other_than_the_catalog_checked_is_refused(self):
        self.installed_one()
        wrong = [{"name": "@openai/codex", "version": "2.0.0", "integrity": self.published_integrity("codex", "1.0.0")}]
        status = self.process([self.request("codex", "2.0.0", "native-bytes", native="2.0.0", packages=wrong)])
        self.assertEqual(status["agents"]["codex"]["request"]["status"], "failed")
        self.assertIn("@openai/codex@2.0.0 does not carry the integrity Paws checked", status["agents"]["codex"]["request"]["error"])
        self.assertFalse((self.base / "agents/codex/2.0.0").exists())
        # Paws must name the native package's integrity, not only its version.
        status = self.process([self.request("codex", "2.0.0", "native-missing", native="2.0.0", packages=[])])
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

    def test_rollback_switches_back_to_the_previous_installed_version(self):
        self.installed_one()
        self.process([self.request("grok", "2.0.0", "update-3")])
        self.assertEqual(self.current("grok"), "2.0.0")
        self.registry.requests.clear()
        status = self.process([self.request("grok", "1.0.0", "rollback-1", integrity=None)])
        self.assertEqual(self.registry.requests, [])
        self.assertEqual(self.current("grok"), "1.0.0")
        self.assertEqual(status["agents"]["grok"]["previous"], "2.0.0")
        self.assertEqual(status["agents"]["grok"]["request"]["status"], "installed")
        status = self.process([self.request("grok", "3.0.0", "rollback-2", integrity=None)])
        self.assertEqual(status["agents"]["grok"]["request"]["status"], "failed")
        self.assertIn("not installed on this runner", status["agents"]["grok"]["request"]["error"])
        self.assertEqual(self.current("grok"), "1.0.0")


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *sys.argv[2:]], verbosity=2)
