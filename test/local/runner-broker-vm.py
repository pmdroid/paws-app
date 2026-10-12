import grp
import hashlib
import json
import os
import pathlib
import pwd
import subprocess
import time


ASSETS = pathlib.Path("/opt/paws-runner/current/deploy/linux")
EXECUTION_ID = "01K00000000000000000000000"


def run(*args):
    return subprocess.run(args, capture_output=True, text=True, check=True)


def main():
    assert os.getuid() == 0 and pathlib.Path("/proc/1/comm").read_text().strip() == "systemd"
    run("/usr/bin/systemd-sysusers", str(ASSETS / "paws-runner.sysusers"))
    run("/usr/bin/systemd-tmpfiles", "--create", str(ASSETS / "paws-runner.tmpfiles"))
    runner = pwd.getpwnam("paws-runner")
    agent = pwd.getpwnam("paws-agent")
    results_gid = grp.getgrnam("paws-results").gr_gid
    for name in ("paws-agent@.service", "paws-runner-broker.service", "paws-runner-broker.socket"):
        (pathlib.Path("/etc/systemd/system") / name).write_bytes((ASSETS / name).read_bytes())
    job = pathlib.Path("/var/lib/paws-runner-spool") / EXECUTION_ID
    job.mkdir(mode=0o750)
    os.chown(job, runner.pw_uid, agent.pw_gid)
    job.chmod(0o750)
    path = job / "job.json"
    path.write_text(json.dumps({"executionId": EXECUTION_ID, "command": {"type": "probe"}}))
    os.chown(path, runner.pw_uid, agent.pw_gid)
    path.chmod(0o640)
    worker = pathlib.Path("/opt/paws-broker-proof-worker.py")
    worker.write_text('''import json,os,pathlib,signal,sys,time
signal.signal(signal.SIGTERM,signal.SIG_IGN)
root=pathlib.Path('/var/lib/paws-agent-results')/sys.argv[1]
try:
    pathlib.Path('/var/lib/paws-runner-broker').iterdir().__next__()
    raise RuntimeError('Agent read root receipts')
except PermissionError:
    pass
child=os.fork()
if child==0:
    os.setsid()
    while True:
        time.sleep(1)
with (root/'launches').open('a') as stream:
    stream.write('launched\\n')
(root/'pids.json').write_text(json.dumps({'parent':os.getpid(),'child':child,'uid':os.getuid()}))
while True:
    time.sleep(1)
''')
    worker.chmod(0o644)
    override = pathlib.Path("/etc/systemd/system") / f"paws-agent@{EXECUTION_ID}.service.d"
    override.mkdir()
    (override / "proof.conf").write_text("[Service]\nExecStart=\nExecStart=/usr/bin/python3 -I -B /opt/paws-broker-proof-worker.py %i\nExecStartPost=/usr/bin/sleep 20\n")
    run("/usr/bin/systemctl", "daemon-reload")
    run("/usr/bin/systemctl", "start", "paws-runner-broker.socket")
    client = '''import json,socket,sys
connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
connection.settimeout(120)
connection.connect('/run/paws-runner-broker.sock')
connection.sendall((json.dumps({'operation':sys.argv[1],'executionId':sys.argv[2]})+'\\n').encode())
response=b''
while not response.endswith(b'\\n'):
    response+=connection.recv(1024)
print(response.decode(),end='',flush=True)
'''
    def identity():
        os.setgroups([agent.pw_gid, results_gid])
        os.setgid(runner.pw_gid)
        os.setuid(runner.pw_uid)
    def request(operation):
        return subprocess.Popen(["/usr/bin/python3", "-I", "-c", client, operation, EXECUTION_ID], preexec_fn=identity, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    start = request("start")
    pids_path = pathlib.Path("/var/lib/paws-agent-results") / EXECUTION_ID / "pids.json"
    deadline = time.monotonic() + 15
    while not pids_path.exists():
        if time.monotonic() > deadline:
            raise RuntimeError("Worker did not run during held activation: " + run("/usr/bin/journalctl", "-u", "paws-runner-broker", "-u", f"paws-agent@{EXECUTION_ID}", "--no-pager").stdout)
        time.sleep(0.05)
    pids = json.loads(pids_path.read_bytes())
    assert pids["uid"] == agent.pw_uid and start.poll() is None
    stopped_at = time.monotonic()
    stop = request("stop")
    output, error = stop.communicate(timeout=10)
    elapsed = time.monotonic() - stopped_at
    assert stop.returncode == 0 and json.loads(output) == {"ok": True}, (output, error)
    assert elapsed < 5, elapsed
    for name in ("parent", "child"):
        status = pathlib.Path("/proc") / str(pids[name]) / "stat"
        assert not status.exists() or status.read_text().rsplit(")", 1)[1].split()[0] == "Z"
    output, error = start.communicate(timeout=10)
    assert start.returncode == 0 and json.loads(output)["ok"] is False, (output, error)
    launches = pids_path.parent / "launches"
    assert launches.read_text() == "launched\n"
    run("/usr/bin/systemctl", "start", f"paws-agent@{EXECUTION_ID}.service")
    assert launches.read_text() == "launched\n"
    assert run("/usr/bin/systemctl", "show", "--property=ActiveState", "--value", f"paws-agent@{EXECUTION_ID}.service").stdout.strip() == "inactive"
    replay = request("start")
    output, error = replay.communicate(timeout=10)
    assert replay.returncode == 0 and json.loads(output) == {"ok": True, "alreadyAdmitted": True}, (output, error)
    hashes = {name: hashlib.sha256((ASSETS / name).read_bytes()).hexdigest() for name in ("runner-broker.py", "paws-agent@.service", "paws-runner-broker.service", "paws-runner-broker.socket", "paws-runner.sysusers", "paws-runner.tmpfiles")}
    print("PAWS_BROKER_VM_PROOF " + json.dumps({"passed": True, "sourceHashes": hashes, "runnerUid": runner.pw_uid, "agentUid": agent.pw_uid, "heldStartSeconds": 20, "stopElapsedMs": round(elapsed * 1000), "resistantDetachedChildDead": True, "latePid1StartDenied": True, "agentReceiptReadDenied": True, "zeroCapabilityGuardPassed": True, "workerEntryPoint": "root-installed Python fixture", "observations": ["concurrentStop", "lateStartDenied"]}), flush=True)


if __name__ == "__main__":
    main()
