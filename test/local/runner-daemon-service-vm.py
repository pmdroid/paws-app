import hashlib
import json
import os
import pathlib
import pwd
import subprocess
import time


ASSETS = pathlib.Path("/opt/paws-runner/current/deploy/linux")
UNIT = pathlib.Path("/etc/systemd/system/paws-runner.service")
HOME = pathlib.Path("/var/lib/paws-runner")


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    assert result.returncode == 0, (args, result.stdout, result.stderr)
    return result.stdout.strip()


def properties():
    return dict(line.split("=", 1) for line in run("/usr/bin/systemctl", "show", "paws-runner.service", "--property=ActiveState,SubState,Result,ExecMainStatus,NRestarts,MainPID").splitlines())


def wait(predicate):
    deadline = time.monotonic() + 15
    while not predicate():
        assert time.monotonic() < deadline, properties()
        time.sleep(0.05)


def main():
    assert os.getuid() == 0 and pathlib.Path("/proc/1/comm").read_text().strip() == "systemd"
    run("/usr/bin/systemd-sysusers", str(ASSETS / "paws-runner.sysusers"))
    run("/usr/bin/systemd-tmpfiles", "--create", str(ASSETS / "paws-runner.tmpfiles"))
    runner = pwd.getpwnam("paws-runner")
    fixture = pathlib.Path("/opt/paws-daemon-service-fixture.py")
    fixture.write_text('''import os,pathlib,signal,subprocess,sys
root=pathlib.Path('/var/lib/paws-runner')
child=subprocess.Popen(['/usr/bin/sleep','infinity'])
def stop(signum,frame):
    child.terminate()
    child.wait(timeout=5)
    (root/'joined.json').write_text(str(child.pid))
    raise SystemExit(130)
signal.signal(signal.SIGTERM,stop)
(root/'ready.json').write_text(str(os.getuid()))
while True:
    signal.pause()
''')
    override = pathlib.Path(str(UNIT) + ".d")
    override.mkdir()
    dropin = override / "proof.conf"
    healthy = "[Service]\nExecStart=\nExecStart=/usr/bin/python3 -I -B /opt/paws-daemon-service-fixture.py\n"
    dropin.write_text(healthy)
    unit = (ASSETS / UNIT.name).read_text()
    assert unit.count("SuccessExitStatus=130\n") == 1

    def start():
        for name in ("ready.json", "joined.json"):
            (HOME / name).unlink(missing_ok=True)
        run("/usr/bin/systemctl", "start", UNIT.name)
        wait(lambda: (HOME / "ready.json").exists())
        assert int((HOME / "ready.json").read_text()) == runner.pw_uid
        assert properties()["ActiveState"] == "active"

    def stop():
        run("/usr/bin/systemctl", "stop", UNIT.name)
        assert (HOME / "joined.json").exists()
        child = pathlib.Path("/proc") / (HOME / "joined.json").read_text()
        assert not child.exists()
        return properties()

    UNIT.write_text(unit.replace("SuccessExitStatus=130\n", ""))
    run("/usr/bin/systemctl", "daemon-reload")
    start()
    baseline = stop()
    assert baseline["ActiveState"] == "failed" and baseline["ExecMainStatus"] == "130" and baseline["Result"] == "exit-code", baseline
    UNIT.write_text(unit)
    run("/usr/bin/systemctl", "daemon-reload")
    run("/usr/bin/systemctl", "reset-failed", UNIT.name)
    start()
    treatment = stop()
    assert treatment["ActiveState"] == "inactive" and treatment["Result"] == "success", treatment
    start()
    restart = stop()
    assert restart["ActiveState"] == "inactive" and restart["Result"] == "success", restart
    dropin.write_text("[Service]\nExecStart=\nExecStart=/usr/bin/false\n")
    run("/usr/bin/systemctl", "daemon-reload")
    subprocess.run(["/usr/bin/systemctl", "start", UNIT.name], capture_output=True, text=True)
    wait(lambda: properties()["Result"] == "exit-code" and properties()["SubState"] == "auto-restart")
    crash = properties()
    assert crash["ExecMainStatus"] == "1" and crash["ActiveState"] == "activating" and crash["SubState"] == "auto-restart", crash
    wait(lambda: int(properties()["NRestarts"]) >= 1)
    retries = properties()
    run("/usr/bin/systemctl", "stop", UNIT.name)
    dropin.write_text(healthy)
    run("/usr/bin/systemctl", "daemon-reload")
    start()
    recovered = stop()
    assert recovered["Result"] == "success" and recovered["ActiveState"] == "inactive", recovered
    names = ("paws-runner.service", "paws-runner.sysusers", "paws-runner.tmpfiles")
    print("PAWS_DAEMON_SERVICE_PROOF " + json.dumps({"passed": True, "pid1": True, "runnerUid": runner.pw_uid, "baseline": baseline, "treatment": treatment, "restart": restart, "crash": crash, "crashRestarts": int(retries["NRestarts"]), "recovered": recovered, "processFixture": "Python SIGTERM handler joins a child then exits130 under the unchanged runner identity and unit hardening; only ExecStart is overridden", "sourceHashes": {name: hashlib.sha256((ASSETS / name).read_bytes()).hexdigest() for name in names}, "observations": ["baselineFailed130", "joinedShutdownSuccess", "healthyRestart", "crashFailureRestarts"]}), flush=True)


if __name__ == "__main__":
    main()
