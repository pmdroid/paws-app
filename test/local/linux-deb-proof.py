import hashlib
import importlib.util
import json
import os
import pathlib
import pwd
import tempfile


ROOT = pathlib.Path("/proof")
spec = importlib.util.spec_from_file_location("source", ROOT / "source.py")
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
source.installer.release.COMMAND_ENV = {**source.installer.release.COMMAND_ENV, "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}
run = source.run


def main():
    if os.getuid() != 0 or pathlib.Path("/opt/paws-runner").exists():
        raise RuntimeError("Use a fresh disposable root namespace")
    source.provision_tools()
    fixture = ROOT / "systemctl-fixture.py"
    fixture.write_text(fixture.read_text().replace('elif args[0] not in ("list-units","stop","daemon-reload","enable"): sys.exit(1)', '''elif args[0]=="is-active":
 services=json.loads(pathlib.Path("/proof/active-services.json").read_text())
 sys.exit(0 if args[-1] in services else 3)
elif args[0] in ("start","stop"):
 path=pathlib.Path("/proof/active-services.json")
 services=set(json.loads(path.read_text()))
 names={name for name in args[1:] if name!="--"}
 services=services|names if args[0]=="start" else services-names
 path.write_text(json.dumps(sorted(services)))
elif args[0]=="daemon-reload" and pathlib.Path("/proof/reload-unavailable").exists(): sys.exit(1)
elif args[0] not in ("list-units","daemon-reload","enable","disable"): sys.exit(1)'''))
    services = ROOT / "active-services.json"
    services.write_text("[]")
    observations = []
    with tempfile.TemporaryDirectory(prefix="paws-deb-proof-") as temporary:
        root = pathlib.Path(temporary)
        private = root / "signing.pem"
        key = root / "release.pub"
        manifest = root / "manifest.json"
        signature = root / "manifest.sig"
        artifact = ROOT / "package/artifact.tar"
        original = json.loads((ROOT / "package/manifest.json").read_text())
        run(["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519", "-out", str(private)])
        run(["/usr/bin/openssl", "pkey", "-in", str(private), "-pubout", "-out", str(key)])
        def build(version, success=True):
            manifest.write_text(json.dumps({**original, "version": version}))
            run(["/usr/bin/openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(private), "-in", str(manifest), "-out", str(signature)])
            output = root / version
            run(["/usr/bin/python3", "-I", "-B", str(ROOT / "deb-package.py"), "--manifest", str(manifest), "--signature", str(signature), "--artifact", str(artifact), "--release-key", str(key), "--output", str(output)], success)
            return next(output.glob("*.deb"), None)
        def install(package, success=True):
            return run(["/usr/bin/dpkg", "--force-depends", "--install", str(package)], success)
        first = build("0.1.1")
        architecture = {"linux-x64": "amd64", "linux-arm64": "arm64"}[original["platform"]]
        assert run(["/usr/bin/dpkg-deb", "--field", str(first), "Architecture"]).strip() == architecture
        assert run(["/usr/bin/dpkg-deb", "--field", str(first), "Depends"]).find("nodejs (>= 22)") >= 0
        with first.open("rb") as completed:
            digest = hashlib.file_digest(completed, "sha256").hexdigest()
        assert first.with_suffix(".deb.sha256").read_text() == f"{digest}  {first.name}\n"
        install(first)
        assert run(["/opt/paws-runner/bin/bun", "--version"]).strip() == "1.4.2"
        assert run(["/opt/paws-runner/bin/claude", "--version"]).strip()
        assert run(["/opt/paws-runner/bin/codex", "--version"]).strip()
        runner = pwd.getpwnam("paws-runner")
        agent = pwd.getpwnam("paws-agent")
        markers = []
        for account in (runner, agent):
            path = pathlib.Path(account.pw_dir) / "preserved-proof"
            path.write_text("preserved local identity state")
            path.chmod(0o600)
            os.chown(path, account.pw_uid, account.pw_gid)
            markers.append(path)
        config = pathlib.Path("/etc/paws-runner/config.json")
        config.write_text("{}")
        config.chmod(0o640)
        os.chown(config, 0, runner.pw_gid)
        observations.append({"name": "native Debian package installs real Bun and provider launchers with separate accounts", "passed": True})
        verifier_files = {str(path): path.read_bytes() for path in pathlib.Path("/var/lib/paws-check-control").rglob("*") if path.is_file()}
        inode = pathlib.Path("/opt/paws-runner/current").resolve().stat().st_ino
        install(first)
        assert pathlib.Path("/opt/paws-runner/current").resolve().stat().st_ino == inode
        assert all(pathlib.Path(path).read_bytes() == content for path, content in verifier_files.items())
        observations.append({"name": "same-version dpkg reinstall preserves verified runtime inode and verification identity", "passed": True})
        active = ["paws-runner.service", "paws-runner-broker.socket"]
        services.write_text(json.dumps(active))
        run(["/usr/bin/python3", "-I", "-B", "/usr/lib/paws-runner-package/deb-control.py", "configure"])
        assert set(json.loads(services.read_text())) == set(active)
        observations.append({"name": "direct postinst reconfiguration restores active services without a preceding prerm", "passed": True})
        for operation, abort in (("upgrade", "abort-upgrade"), ("remove", "abort-remove"), ("deconfigure", "abort-deconfigure"), ("upgrade", "failed-upgrade")):
            run(["/bin/sh", "/var/lib/dpkg/info/paws-runner.prerm", operation, "0.1.2"])
            assert json.loads(services.read_text()) == []
            script = "postrm" if abort == "failed-upgrade" else "postinst"
            run(["/bin/sh", "/var/lib/dpkg/info/paws-runner." + script, abort, "0.1.2"])
            assert set(json.loads(services.read_text())) == set(active)
        observations.append({"name": "real package maintainer abort paths restore previously active services", "passed": True})
        second = build("0.1.2")
        worker = ROOT / "active-worker"
        worker.write_text("paws-agent@01K00000000000000000000000.service")
        install(second, False)
        assert pathlib.Path("/opt/paws-runner/current").resolve().name == "0.1.1"
        assert set(json.loads(services.read_text())) == set(active)
        worker.unlink()
        observations.append({"name": "actual dpkg upgrade refuses active execution without stopping its daemon", "passed": True})
        install(second)
        assert pathlib.Path("/opt/paws-runner/current").resolve().name == "0.1.2"
        assert set(json.loads(services.read_text())) == set(active)
        assert all(path.read_text() == "preserved local identity state" for path in markers)
        assert config.read_text() == "{}"
        observations.append({"name": "upgrade restarts previously active services and preserves configuration and agent state", "passed": True})
        install(first, False)
        assert pathlib.Path("/opt/paws-runner/current").resolve().name == "0.1.2"
        assert set(json.loads(services.read_text())) == set(active)
        observations.append({"name": "dpkg downgrade fails before stopping the installed release", "passed": True})
        unavailable = ROOT / "reload-unavailable"
        unavailable.touch()
        run(["/usr/bin/dpkg", "--remove", "paws-runner"])
        unavailable.unlink()
        assert not pathlib.Path("/opt/paws-runner").exists()
        assert json.loads(services.read_text()) == []
        assert all(path.exists() for path in markers) and config.exists()
        observations.append({"name": "removal stops services and removes runtime despite unavailable systemd reload, preserving local state", "passed": True})
        install(second)
        assert pathlib.Path("/opt/paws-runner/current").resolve().name == "0.1.2"
        run(["/usr/bin/dpkg", "--purge", "paws-runner"])
        assert not config.exists() and all(path.exists() for path in markers)
        observations.append({"name": "reinstall after removal succeeds and purge removes configuration without deleting agent state", "passed": True})
        signature.write_bytes(bytes(64))
        run(["/usr/bin/python3", "-I", "-B", str(ROOT / "deb-package.py"), "--manifest", str(manifest), "--signature", str(signature), "--artifact", str(artifact), "--release-key", str(key), "--output", str(root / "invalid")], False)
        assert not list((root / "invalid").glob("*.deb"))
        observations.append({"name": "invalid signed inputs produce no Debian package", "passed": True})
    print(json.dumps({"observations": observations, "systemctlLifecycle": "recording fixture", "packageManager": "real dpkg with dependency resolution bypassed in disposable namespace", "architecture": architecture}))


if __name__ == "__main__":
    main()
