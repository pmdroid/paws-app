import importlib.util
import hashlib
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid


EXECUTION_ID = "01K00000000000000000000000"
mode, root_name = sys.argv[1:3]
root = Path(root_name).resolve()
source = Path(__file__).resolve().parents[2]


def mapped(operation):
    return ["/usr/bin/unshare", "--user", "--map-root-user", "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "/usr/bin/python3", "-I", "-B", str(Path(__file__).resolve()), operation, str(root)]


def manager(*arguments):
    return subprocess.run(["/usr/bin/systemctl", "--user", *arguments], check=True, capture_output=True, text=True).stdout.strip()


if mode in ("admit", "guard", "expired", "expire", "arm-failure", "guard-failure", "arm-recovery", "clock-fence"):
    spec = importlib.util.spec_from_file_location("broker", source / "deploy/linux/runner-broker.py")
    broker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(broker)
    broker.lifecycle.__wrapped__.__defaults__ = (str(root / "receipts"),)
    config = json.loads((root / "config.json").read_text())
    if mode == "admit":
        assert broker.admit_once(EXECUTION_ID, {"type": "probe", "expiresAt": config["expiresAt"]})
        assert not broker.admit_once(EXECUTION_ID, {"type": "probe", "expiresAt": config["expiresAt"]})
        try:
            broker.admit_once(EXECUTION_ID, {"type": "probe", "expiresAt": config["expiresAt"] + 60000})
            raise AssertionError("Changed command admitted")
        except ValueError:
            pass
        receipt = json.loads((root / "receipts" / (EXECUTION_ID + ".expiry")).read_text())
        assert receipt["expiresAt"] == config["expiresAt"] and len(receipt["commandDigest"]) == 64
        for value in (None, True, "123", -1, 9007199254740992, int(time.time() * 1000) - 1):
            try:
                broker.admit_once("01K00000000000000000000001", {"type": "probe", "expiresAt": value})
                raise AssertionError("Invalid expiry admitted")
            except ValueError:
                pass
        restart_id = "01K00000000000000000000003"
        restart_command = {"type": "probe", "expiresAt": config["expiresAt"]}
        original_mark = broker.mark_once
        def interrupted(directory, name):
            if name == restart_id:
                raise RuntimeError("Crash before admission")
            return original_mark(directory, name)
        broker.mark_once = interrupted
        try:
            broker.admit_once(restart_id, restart_command)
            raise AssertionError("Crash injection did not execute")
        except RuntimeError:
            pass
        broker.mark_once = original_mark
        assert not (root / "receipts" / restart_id).exists()
        assert broker.admit_once(restart_id, restart_command)
        assert not broker.admit_once(restart_id, restart_command)
        sys.exit(0)
    if mode in ("arm-failure", "guard-failure"):
        execution_id = "01K00000000000000000000002"
        if mode == "arm-failure":
            assert broker.admit_once(execution_id, {"type": "probe", "expiresAt": time.time_ns() // 1000000 + 10000})
        def unavailable(arguments, **options):
            raise subprocess.TimeoutExpired(arguments, options["timeout"])
        broker.subprocess.run = unavailable
        try:
            broker.guard(execution_id)
            raise AssertionError("Failed timer admitted worker")
        except subprocess.TimeoutExpired:
            if mode == "guard-failure":
                sys.exit(255)
        assert not (root / "receipts" / (execution_id + ".launched")).exists()
        sys.exit(0)
    if mode == "clock-fence":
        clock_id = "01K00000000000000000000004"
        clock_expiry = time.time_ns() // 1000000 + 10000
        assert broker.admit_once(clock_id, {"type": "probe", "expiresAt": clock_expiry})
        original_clock = time.time_ns
        time.time_ns = lambda: (clock_expiry + 1) * 1000000
        assert not broker.guard(clock_id)
        assert (root / "receipts" / (clock_id + ".stopped")).exists()
        time.time_ns = original_clock
        assert not broker.guard(clock_id)
        sys.exit(0)
    original_run = subprocess.run
    def transport(arguments, **options):
        if arguments[0] == "/usr/bin/systemctl":
            expected = "paws-agent@" + EXECUTION_ID + ".service" if mode == "expire" else "paws-agent-expiry-" + EXECUTION_ID + ".timer"
            actual = config["unit"] if mode == "expire" else config["unit"][:-8] + "-expiry.timer"
            assert arguments[-1] == expected
            forwarded = [actual if part == expected else part for part in arguments]
            options["env"] = {**options.get("env", {}), "XDG_RUNTIME_DIR": config["runtimeDir"], "DBUS_SESSION_BUS_ADDRESS": "unix:path=" + config["runtimeDir"] + "/bus"}
            return original_run([forwarded[0], "--user", *forwarded[1:]], **options)
        assert arguments[:2] == ["/usr/bin/systemd-run", "--unit=paws-agent-expiry-" + EXECUTION_ID]
        assert arguments[-3:] == ["/opt/paws-runner/current/deploy/linux/runner-broker.py", "expire", EXECUTION_ID]
        (root / "armed.json").write_text(json.dumps({"arguments": arguments, "at": time.time_ns() // 1000000, "uid": os.getuid(), "capabilities": next(line.strip() for line in open("/proc/self/status") if line.startswith("CapEff:"))}))
        selected = [part for part in arguments[2:-6] if not part.startswith("--property=")]
        return original_run(["/usr/bin/systemd-run", "--user", "--unit=" + config["unit"][:-8] + "-expiry", *selected, *mapped("expire")], **options)
    broker.subprocess.run = transport
    if mode == "arm-recovery":
        original_mark = broker.mark_once
        def interrupted(directory, name):
            if name == EXECUTION_ID + ".launched":
                raise RuntimeError("Crash after arming")
            return original_mark(directory, name)
        broker.mark_once = interrupted
        try:
            broker.guard(EXECUTION_ID)
            raise AssertionError("Guard crash did not execute")
        except RuntimeError:
            pass
        broker.mark_once = original_mark
        with broker.lifecycle(EXECUTION_ID) as directory:
            assert broker.arm_deadline(directory, EXECUTION_ID)
        assert not (root / "receipts" / (EXECUTION_ID + ".launched")).exists()
        sys.exit(0)
    if mode == "expire":
        assert broker.stop_unit(EXECUTION_ID)
        (root / "expiry-joined").write_text(str(time.time_ns() // 1000000))
        sys.exit(0)
    allowed = broker.guard(EXECUTION_ID)
    if mode == "expired":
        assert not allowed
        sys.exit(0)
    sys.exit(0 if allowed else 1)

if mode == "worker":
    child = subprocess.Popen(["/usr/bin/python3", "-c", "import os,signal,time; os.setsid(); signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(120)"])
    while os.getsid(child.pid) != child.pid:
        time.sleep(0.005)
    (root / "pids.json").write_text(json.dumps({"parent": os.getpid(), "child": child.pid, "childSession": os.getsid(child.pid)}))
    time.sleep(120)
    sys.exit(0)

if mode == "daemon":
    config = json.loads((root / "config.json").read_text())
    subprocess.run(config["start"], check=True, capture_output=True)
    (root / "daemon-ready").write_text(str(os.getpid()))
    time.sleep(120)
    sys.exit(0)

if mode != "proof":
    raise ValueError("Invalid proof operation")
root.mkdir(mode=0o700, parents=True, exist_ok=True)
paths = ["deploy/linux/runner-broker.py", "deploy/linux/paws-agent@.service", "test/local/runner-deadline.py"]
source_hashes = {path: hashlib.sha256((source / path).read_bytes()).hexdigest() for path in paths}
(root / "receipts").mkdir(mode=0o700)
unit = "paws-expiry-proof-" + uuid.uuid4().hex + ".service"
unit_source = (source / "deploy/linux/paws-agent@.service").read_text()
properties = dict(line.split("=", 1) for line in unit_source.splitlines() if "=" in line)
assert properties["KillMode"] == "control-group" and properties["KillSignal"] == "SIGKILL"
assert properties["TimeoutStartSec"] == "30s" and properties["TimeoutStopSec"] == "30s"
expiry = time.time_ns() // 1000000 + 8000
start = ["/usr/bin/systemd-run", "--user", "--unit=" + unit, "--property=Type=exec", "--property=ExecCondition=" + " ".join(mapped("guard")), *["--property=" + key + "=" + properties[key] for key in ("KillMode", "KillSignal", "TimeoutStartSec", "TimeoutStopSec", "SendSIGKILL")], "/usr/bin/python3", str(Path(__file__).resolve()), "worker", str(root)]
(root / "config.json").write_text(json.dumps({"unit": unit, "expiresAt": expiry, "start": start, "runtimeDir": "/run/user/" + str(os.getuid())}))
subprocess.run(mapped("admit"), check=True)
subprocess.run(mapped("arm-failure"), check=True)
subprocess.run(mapped("clock-fence"), check=True)
subprocess.run(mapped("arm-recovery"), check=True)
failure = subprocess.run(["/usr/bin/systemd-run", "--user", "--unit=" + unit[:-8] + "-failure", "--wait", "--collect", "--property=Type=exec", "--property=ExecCondition=" + " ".join(mapped("guard-failure")), "/usr/bin/touch", str(root / "unexpected-start")], capture_output=True)
assert failure.returncode != 0 and not (root / "unexpected-start").exists()
time.sleep(3)
daemon = subprocess.Popen(["/usr/bin/python3", str(Path(__file__).resolve()), "daemon", str(root)])
try:
    while not (root / "daemon-ready").exists() or not (root / "pids.json").exists():
        if daemon.poll() is not None or time.time_ns() // 1000000 >= expiry:
            raise RuntimeError("Deadline unit did not start")
        time.sleep(0.01)
    pids = json.loads((root / "pids.json").read_text())
    assert pids["child"] == pids["childSession"]
    daemon.kill()
    daemon.wait(timeout=5)
    assert daemon.returncode == -signal.SIGKILL
    assert manager("show", unit, "--property=ActiveState", "--value") == "active"
    while manager("show", unit, "--property=ActiveState", "--value") == "active":
        if time.time_ns() // 1000000 > expiry + 60000:
            raise RuntimeError("Signed expiry teardown bound exceeded")
        time.sleep(0.02)
    for pid in pids.values():
        status = Path("/proc") / str(pid) / "stat"
        assert not status.exists() or status.read_text().split()[2] == "Z"
    armed = json.loads((root / "armed.json").read_text())
    assert armed["uid"] == 0 and armed["capabilities"].endswith("0000000000000000")
    calendar = next(part for part in armed["arguments"] if part.startswith("--on-calendar=")).split("=", 1)[1]
    calendar_expiry = round(datetime.strptime(calendar, "%Y-%m-%d %H:%M:%S.%f UTC").replace(tzinfo=timezone.utc).timestamp() * 1000)
    assert calendar_expiry == expiry
    assert time.time_ns() // 1000000 - armed["at"] >= 3000
    result = manager("show", unit, "--property=Result", "--value")
    assert result in ("signal", "success")
    while not (root / "expiry-joined").exists():
        if time.time_ns() // 1000000 > expiry + 60000:
            raise RuntimeError("Expiry join not confirmed")
        time.sleep(0.01)
    subprocess.run(mapped("expired"), check=True)
    original_pids = (root / "pids.json").read_bytes()
    manager("start", unit)
    assert manager("show", unit, "--property=ActiveState", "--value") == "inactive"
    assert (root / "pids.json").read_bytes() == original_pids
    assert source_hashes == {path: hashlib.sha256((source / path).read_bytes()).hexdigest() for path in paths}
    (root / "source-hashes.json").write_text(json.dumps(source_hashes, indent=2))
    observed = {"expiry": expiry, "stoppedAt": time.time_ns() // 1000000, "calendarExpiryMs": calendar_expiry, "daemonSignal": daemon.returncode, "pids": pids, "result": result, "activationBoundSeconds": 30, "stopBoundSeconds": 30, "receiptImmutable": True, "invalidExpiryRejected": True, "expiredGuardRejected": True, "rootGuardWithoutCapabilities": True, "lateActivationRejected": True, "armingFailureRejected": True, "commandDigestBound": True, "expiryCrashRecovered": True, "armingCrashRecovered": True, "clockStepFenceRetained": True}
    (root / "observations.json").write_text(json.dumps(observed, indent=2))
    print(json.dumps(observed))
finally:
    if daemon.poll() is None:
        daemon.kill()
        daemon.wait(timeout=5)
    subprocess.run(["/usr/bin/systemctl", "--user", "stop", unit], capture_output=True)
    subprocess.run(["/usr/bin/systemctl", "--user", "reset-failed", unit], capture_output=True)
    subprocess.run(["/usr/bin/systemctl", "--user", "stop", unit[:-8] + "-expiry.timer", unit[:-8] + "-expiry.service"], capture_output=True)
