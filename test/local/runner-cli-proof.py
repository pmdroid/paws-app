import json
import os
import pathlib
import selectors
import shutil
import signal
import ssl
import stat
import subprocess
import sys
import time
import urllib.request


observations = []
actors = []
root = pathlib.Path("/state")
root.mkdir(mode=0o755)
for name, uid in (("paws-runner", 17001), ("paws-agent", 17002)):
    subprocess.run(["/usr/sbin/groupadd", "--gid", str(uid), name], check=True)
    subprocess.run(["/usr/sbin/useradd", "--uid", str(uid), "--gid", str(uid), "--no-create-home", "--home-dir", f"/var/lib/{name}", "--shell", "/usr/sbin/nologin", name], check=True)
subprocess.run(["/usr/sbin/groupadd", "--gid", "17003", "paws-results"], check=True)
for path, uid, gid, mode in (("/state/server", 17004, 17004, 0o700), ("/var/lib/paws-runner", 17001, 17001, 0o700), ("/var/lib/paws-agent", 17002, 17002, 0o700), ("/var/lib/paws-runner-spool", 17001, 17002, 0o2750), ("/var/lib/paws-agent-results", 0, 17003, 0o750), ("/etc/paws-runner", 0, 0, 0o755), ("/opt/paws-runner/bin", 0, 0, 0o755)):
    target = pathlib.Path(path)
    target.mkdir(parents=True, exist_ok=True)
    os.chown(target, uid, gid)
    target.chmod(mode)


def actor(arguments, uid):
    process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin", "HOME": "/var/lib/paws-agent" if uid == 17002 else "/var/lib/paws-runner", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent", "GH_TOKEN": "synthetic-parent", "AWS_ACCESS_KEY_ID": "synthetic-parent", "SSH_AUTH_SOCK": "/synthetic-parent"}, user=uid, group=uid, extra_groups=[17003] if uid == 17002 else [17002, 17003] if uid == 17001 else [], start_new_session=True)
    actors.append(process)
    return process


def command(args, uid, expected=1):
    process = actor(["/proof/bun", "--no-env-file", "/proof/paws.js", "runner", *args], uid)
    output, errors = process.communicate(timeout=15)
    if process.returncode != expected:
        details = {str(item): {"uid": item.stat().st_uid, "gid": item.stat().st_gid, "mode": oct(stat.S_IMODE(item.stat().st_mode)), "size": item.stat().st_size} for base in ("/var/lib/paws-runner-spool", "/var/lib/paws-agent-results", "/var/lib/paws-agent") for item in pathlib.Path(base).rglob("*")}
        print(json.dumps(details), file=sys.stderr)
    assert process.returncode == expected, (args, process.returncode, output, errors)
    if expected == 1:
        assert errors == b"Runner command failed. Check the service identity, configuration and pairing.\n", errors
    return output


def observe(name):
    observations.append({"name": name, "passed": True})


def line(process):
    ready = selectors.DefaultSelector()
    ready.register(process.stdout, selectors.EVENT_READ)
    try:
        assert ready.select(15), "CLI output timeout"
        value = process.stdout.readline()
        if not value:
            raise AssertionError((process.poll(), process.stderr.read().decode()))
        return json.loads(value)
    finally:
        ready.close()


try:
    server = actor(["/proof/bun", "--no-env-file", "/proof/instance.js"], 17004)
    deadline = time.monotonic() + 15
    ready = root / "server/ready.json"
    while not ready.exists():
        assert server.poll() is None, server.stderr.read().decode()
        assert time.monotonic() < deadline
        time.sleep(0.02)
    config = json.loads(ready.read_text())
    path = pathlib.Path("/etc/paws-runner/config.json")

    def install_config(value=config):
        path.unlink(missing_ok=True)
        path.write_text(json.dumps(value))
        os.chown(path, 0, 17001)
        path.chmod(0o640)

    install_config()
    arguments = ["pair", "--config", str(path), "--name", "CLI fixture"]
    if len(sys.argv) > 1 and sys.argv[1] == "baseline":
        baseline = actor(["/proof/bun", "--no-env-file", "/proof/paws.js", "runner", *arguments], 17001)
        assert line(baseline)["phase"] == "pending"
        raise AssertionError("Baseline unexpectedly supported runner pairing")
    if len(sys.argv) > 1 and sys.argv[1] == "verifier-baseline":
        baseline = actor(["/proof/bun", "--no-env-file", "/proof/paws.js", "runner", *arguments], 17001)
        assert line(baseline)["phase"] == "pending"
        raise AssertionError("Baseline enrolled without an installed verifier identity")
    command(arguments, 17001)
    public = pathlib.Path("/var/lib/paws-check-verifier-public.pem")
    identity = json.loads(subprocess.run(["/usr/bin/python3", "-I", "-B", "/proof/check-verifier.py", "initialize"], check=True, capture_output=True).stdout)
    repeated = json.loads(subprocess.run(["/usr/bin/python3", "-I", "-B", "/proof/check-verifier.py", "initialize"], check=True, capture_output=True).stdout)
    assert repeated == identity
    original_public = public.read_bytes()
    for uid in (17001, 17002):
        denied = actor(["/bin/cat", "/var/lib/paws-check-verifier/key.pem"], uid)
        denied.communicate(timeout=5)
        assert denied.returncode != 0
    for invalid in ("owner", "group", "mode", "oversized", "malformed", "symlink", "hardlink", "fifo"):
        public.unlink()
        public.write_bytes(original_public)
        os.chown(public, 0, 0)
        public.chmod(0o644)
        if invalid == "owner":
            os.chown(public, 17001, 0)
        elif invalid == "group":
            os.chown(public, 0, 17001)
        elif invalid == "mode":
            public.chmod(0o666)
        elif invalid == "oversized":
            public.write_bytes(b"x" * 257)
        elif invalid == "malformed":
            public.write_bytes(original_public + b"\n")
        elif invalid == "symlink":
            public.unlink()
            public.symlink_to(ready)
        elif invalid == "hardlink":
            os.link(public, root / "linked-public.pem")
        else:
            public.unlink()
            os.mkfifo(public, 0o644)
        command(arguments, 17001)
    public.unlink()
    public.write_bytes(original_public)
    public.chmod(0o644)
    observe("privileged installed verifier identity is stable and unsafe or missing public identities cannot enroll")
    command(arguments, 0)
    command(["worker", "--execution-id", "01J00000000000000000000001"], 17001)
    observe("pairing and worker reject the wrong real service UIDs")
    for invalid in ("mode", "oversized", "field", "symlink", "hardlink", "fifo"):
        install_config()
        if invalid == "mode":
            path.chmod(0o666)
        elif invalid == "oversized":
            path.write_bytes(b"x" * 65537)
        elif invalid == "field":
            install_config({**config, "command": "/bin/false"})
        elif invalid == "symlink":
            path.unlink()
            path.symlink_to(ready)
        elif invalid == "hardlink":
            os.link(path, path.with_suffix(".linked"))
        else:
            path.unlink()
            os.mkfifo(path, 0o640)
            os.chown(path, 0, 17001)
        command(arguments, 17001)
    observe("unsafe modes, oversized input, unknown fields, links and FIFO configuration fail closed")
    install_config()
    context = ssl.create_default_context(cadata=config["serverCa"])

    def http(endpoint, payload=None):
        request = urllib.request.Request(config["controlPlaneUrl"] + endpoint, data=None if payload is None else json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, context=context, timeout=10) as response:
            return json.load(response)

    for invalid in ({**config, "serverCa": "invalid"}, {**config, "controlPlaneUrl": config["controlPlaneUrl"].replace("localhost", "127.0.0.1")}):
        install_config(invalid)
        command(arguments, 17001)
        shutil.rmtree("/var/lib/paws-runner")
        pathlib.Path("/var/lib/paws-runner").mkdir(mode=0o700)
        os.chown("/var/lib/paws-runner", 17001, 17001)
    assert http("/fixture/count")["enrollmentRequests"] == 0
    observe("actual HTTPS refuses untrusted and wrong-hostname servers before enrollment")
    install_config()
    pair = actor(["/proof/bun", "--no-env-file", "/proof/paws.js", "runner", *arguments], 17001)
    pending = line(pair)
    assert pending["phase"] == "pending" and len(pending["code"]) == 16
    assert "claim" not in pending and "certificate" not in pending
    assert pending["verifierFingerprint"] == identity["fingerprint"]
    pair.send_signal(signal.SIGTERM)
    output, errors = pair.communicate(timeout=15)
    assert pair.returncode == 130, (pair.returncode, errors)
    replacement = subprocess.run(["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519"], check=True, capture_output=True).stdout
    public.write_bytes(subprocess.run(["/usr/bin/openssl", "pkey", "-pubout"], input=replacement, check=True, capture_output=True).stdout)
    command(arguments, 17001)
    public.write_bytes(original_public)
    restarted = actor(["/proof/bun", "--no-env-file", "/proof/paws.js", "runner", *arguments], 17001)
    assert line(restarted) == pending
    inspected = http("/api/runners/pairings/inspect", {"code": pending["code"]})
    assert inspected["requestFingerprint"] == pending["requestFingerprint"]
    assert inspected["verifierFingerprint"] == identity["fingerprint"]
    for wrong in (None, "0" * 64):
        try:
            http("/api/runners/pairings/approve", {"code": pending["code"], **({"verifierFingerprint": wrong} if wrong else {})})
        except urllib.error.HTTPError as failure:
            assert failure.code == 403
        else:
            raise AssertionError("Pairing approved a different verifier fingerprint")
    http("/api/runners/pairings/approve", {"code": pending["code"], "verifierFingerprint": identity["fingerprint"]})
    paired = line(restarted)
    assert paired["paired"] is True and paired["verifierFingerprint"] == identity["fingerprint"]
    output, errors = restarted.communicate(timeout=15)
    assert restarted.returncode == 0, errors
    observe("real CLI pairing survives process interruption and claims only after administrator approval")
    observe("actual HTTPS enrollment pins the installed verifier and rejects changed keys or mismatched approval")
    private_key = pathlib.Path("/var/lib/paws-runner/identity/runner-key.pem")
    assert private_key.is_file() and private_key.stat().st_size > 0
    denied = actor(["/bin/cat", str(private_key)], 17002)
    denied.communicate(timeout=5)
    assert denied.returncode != 0
    observe("agent UID cannot read daemon identity")
    publisher = actor(["/proof/bun", "--no-env-file", "/proof/instance.js", "job"], 17001)
    output, errors = publisher.communicate(timeout=10)
    assert publisher.returncode == 0, errors
    execution = "01J00000000000000000000001"
    results = pathlib.Path("/var/lib/paws-agent-results") / execution
    results.mkdir(mode=0o750)
    os.chown(results, 17002, 17003)
    pathlib.Path("/proof/package.json").write_text(json.dumps({"name": "paws"}))
    pathlib.Path("/proof/node_modules/.bin").mkdir(parents=True)
    launcher = pathlib.Path("/proof/node_modules/.bin/claude-agent-acp")
    launcher.write_text("#!/bin/sh\nexec /proof/bun --no-env-file /proof/fake-agent.js /var/lib/paws-agent/agent.json /proof/script.json\n")
    launcher.chmod(0o755)
    command(["worker", "--execution-id", execution], 17002, 0)
    result = json.loads((results / "result.json").read_text())
    assert result["executionId"] == execution and result["run"]["agentExited"] is True
    info = (results / "result.json").stat()
    assert (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (17002, 17003, 0o640)
    recorded = json.loads(pathlib.Path("/var/lib/paws-agent/agent.json").read_text())
    assert "initialize" in recorded["methods"] and "session/new" in recorded["methods"]
    assert recorded["env"] == {"xaiApiKey": False, "ghToken": False, "sshAuthSock": False, "aws": False}
    command(["worker", "--execution-id", execution], 17002)
    command(["worker", "--execution-id", "../../escape"], 17002)
    observe("production worker entrypoint uses fixed paths, isolated ACP credentials and immutable execution results")
    cancelled_execution = "01J00000000000000000000002"
    publisher = actor(["/proof/bun", "--no-env-file", "/proof/instance.js", "job", cancelled_execution], 17001)
    output, errors = publisher.communicate(timeout=10)
    assert publisher.returncode == 0, errors
    cancelled_results = pathlib.Path("/var/lib/paws-agent-results") / cancelled_execution
    cancelled_results.mkdir(mode=0o750)
    os.chown(cancelled_results, 17002, 17003)
    pathlib.Path("/var/lib/paws-agent/hang.json").write_text(json.dumps({"steps": [], "hangInitialize": True}))
    launcher.write_text("#!/bin/sh\nexec /proof/bun --no-env-file /proof/fake-agent.js /var/lib/paws-agent/cancelled-agent.json /var/lib/paws-agent/hang.json\n")
    worker = actor(["/proof/bun", "--no-env-file", "/proof/paws.js", "runner", "worker", "--execution-id", cancelled_execution], 17002)
    record = pathlib.Path("/var/lib/paws-agent/cancelled-agent.json")
    deadline = time.monotonic() + 10
    while not record.exists():
        assert worker.poll() is None
        assert time.monotonic() < deadline
        time.sleep(0.02)
    worker.send_signal(signal.SIGTERM)
    output, errors = worker.communicate(timeout=15)
    assert worker.returncode == 130, (worker.returncode, errors)
    cancelled = json.loads((cancelled_results / "result.json").read_text())
    assert cancelled["run"]["cancelled"] is True and cancelled["run"]["agentExited"] is True
    observe("SIGTERM joins the owned ACP process and retains the cancelled immutable result")
    server.send_signal(signal.SIGTERM)
    server.communicate(timeout=15)
    assert server.returncode == 0
    print(json.dumps({"passed": True, "observations": observations, "network": "none", "uids": {"runner": 17001, "agent": 17002, "coordinator": 17004}, "pairedRunnerId": paired["runnerId"]}))
finally:
    for process in actors:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=5)
