import argparse
import importlib.util
import json
import pathlib
import subprocess
import tempfile
from types import SimpleNamespace


ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("installer", ROOT / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
UNITS = ("paws-runner-broker.socket", "paws-runner-broker.service", "paws-runner.service")
RESTART = installer.STATE / "debian-services.json"


def active_services():
    active = []
    for unit in UNITS:
        result = subprocess.run(["/usr/bin/systemctl", "is-active", "--quiet", unit], env=installer.release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
        if result.returncode == 0:
            active.append(unit)
        elif result.returncode not in (3, 4):
            raise ValueError("Cannot determine runner service state")
    return active


def stop(next_version):
    current = installer.release.parse_manifest(installer.release.read_regular(ROOT / "manifest.json", 65536))
    if next_version is not None:
        if not installer.release.SEMVER.fullmatch(next_version) or tuple(map(int, next_version.split("."))) < tuple(map(int, current["version"].split("."))):
            raise ValueError("Runner package downgrades are not allowed")
    installer.refuse_active_executions()
    active = active_services()
    if not RESTART.exists():
        installer.write_atomic(RESTART, json.dumps(active).encode(), 0o600)
    installer.stop_for_install()


def configure():
    arguments = SimpleNamespace(**{name: str(ROOT / filename) for name, filename in (("manifest", "manifest.json"), ("signature", "manifest.sig"), ("artifact", "artifact.tar"), ("release_key", "release.pub"))})
    with tempfile.TemporaryDirectory(prefix="paws-debian-") as temporary:
        manifest, artifact, fingerprint = installer.release.verify_release(arguments, pathlib.Path(temporary))
        if not RESTART.exists():
            installer.write_atomic(RESTART, json.dumps(active_services()).encode(), 0o600)
        installed = installer.install(manifest, artifact, fingerprint, reinstall=True)
    restore()
    print(json.dumps(installed))


def restore():
    try:
        active = json.loads(installer.release.read_regular(RESTART, 65536))
    except FileNotFoundError:
        active = []
    if not isinstance(active, list) or any(unit not in UNITS for unit in active):
        raise ValueError("Invalid runner restart state")
    if active:
        installer.release.command(["/usr/bin/systemctl", "start", "--", *active])
    RESTART.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("configure", "stop", "restore"))
    parser.add_argument("--next-version")
    arguments = parser.parse_args()
    if arguments.operation == "configure":
        configure()
    elif arguments.operation == "restore":
        restore()
    else:
        stop(arguments.next_version)


if __name__ == "__main__":
    main()
