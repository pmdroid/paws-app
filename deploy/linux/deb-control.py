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
UNITS = ("paws-runner.service",)
RETIRED = ("paws-runner-broker.socket", "paws-runner-broker.service")
RESTART = installer.STATE / "debian-services.json"


def active_services():
    active = []
    for unit in UNITS:
        result = subprocess.run(["/usr/bin/systemctl", "is-active", unit], env=installer.release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
        # A daemon waiting out RestartSec after a crash is "activating" and exits 3; it is meant to run.
        if result.returncode == 0 or result.stdout.strip() == b"activating":
            active.append(unit)
        elif result.returncode not in (3, 4):
            raise ValueError("Cannot determine runner service state")
    return active


def enabled_services():
    enabled = []
    for unit in UNITS:
        result = subprocess.run(["/usr/bin/systemctl", "is-enabled", unit], env=installer.release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
        if result.returncode == 0 and result.stdout.strip() in (b"enabled", b"enabled-runtime"):
            enabled.append(unit)
    return enabled


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
        # The agents install beside the current ones first; a failure stops here, naming the agent,
        # with the installed release and agents unchanged.
        installer.prerequisites()
        agents = installer.prepare_agents(artifact)
        installed = installer.install(manifest, artifact, fingerprint, reinstall=True)
        installed["agents"] = installer.finish_agents(agents)
    restore()
    # Agent versions sent from the Runners page install through this path unit (install.py agent-requests).
    installer.release.command(["/usr/bin/systemctl", "enable", "--now", "--", "paws-runner-agents.path"])
    print(json.dumps(installed))


def restore():
    try:
        active = json.loads(installer.release.read_regular(RESTART, 65536))
    except FileNotFoundError:
        active = []
    if not isinstance(active, list) or any(unit not in {*UNITS, *RETIRED} for unit in active):
        raise ValueError("Invalid runner restart state")
    # Enrollment ends with `systemctl enable --now`, so an enabled runner always starts again,
    # whatever state the upgrade found it in.
    start = [unit for unit in UNITS if unit in active or unit in enabled_services()]
    if start:
        installer.release.command(["/usr/bin/systemctl", "start", "--", *start])
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
