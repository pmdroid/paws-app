import base64
import grp
import hashlib
import json
import os
import pathlib
import pwd
import subprocess
import time


ASSETS = pathlib.Path("/opt/paws-runner/current/deploy/linux")
ATTEMPT = "01K00000000000000000000001"


def run(*arguments, **options):
    return subprocess.run(arguments, capture_output=True, text=True, check=True, **options)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def dead(pid):
    path = pathlib.Path("/proc") / str(pid) / "stat"
    return not path.exists() or path.read_text().rsplit(")", 1)[1].split()[0] == "Z"


def main():
    assert os.getuid() == 0 and pathlib.Path("/proc/1/comm").read_text().strip() == "systemd"
    run("/usr/bin/systemd-sysusers", str(ASSETS / "paws-runner.sysusers"))
    run("/usr/bin/systemd-tmpfiles", "--create", str(ASSETS / "paws-runner.tmpfiles"))
    runner = pwd.getpwnam("paws-runner")
    check = pwd.getpwnam("paws-check")
    input_gid = grp.getgrnam("paws-check-input").gr_gid
    for name in ("paws-agent@.service", "paws-runner-broker.service", "paws-runner-broker.socket", "paws-check@.service", "paws-check-witness@.service"):
        (pathlib.Path("/etc/systemd/system") / name).write_bytes((ASSETS / name).read_bytes())
    identity = json.loads(run("/usr/bin/python3", "-I", "-B", str(ASSETS / "check-verifier.py"), "initialize").stdout)
    run("/usr/bin/systemctl", "daemon-reload")
    run("/usr/bin/systemctl", "start", "paws-runner-broker.socket")
    source = pathlib.Path("/root/source")
    source.mkdir()
    run("/usr/bin/git", "init", str(source))
    run("/usr/bin/git", "-C", str(source), "config", "user.email", "fixture@localhost")
    run("/usr/bin/git", "-C", str(source), "config", "user.name", "Fixture")
    (source / ".gitignore").write_text(".paws-deps/\n")
    (source / "tracked").write_text("original\n")
    run("/usr/bin/git", "-C", str(source), "add", ".")
    run("/usr/bin/git", "-C", str(source), "commit", "-m", "fixture")
    candidate = run("/usr/bin/git", "-C", str(source), "rev-parse", "HEAD").stdout.strip()
    def ordinary_check():
        os.setgroups([])
        os.setgid(check.pw_gid)
        os.setuid(check.pw_uid)
    nested = run("/usr/bin/git", "-C", str(source), "rev-parse", "HEAD").stdout.strip()
    run("/usr/bin/git", "-C", str(source), "update-index", "--add", "--cacheinfo", "160000," + nested + ",nested")
    run("/usr/bin/git", "-C", str(source), "commit", "-m", "gitlink fixture")
    candidate = run("/usr/bin/git", "-C", str(source), "rev-parse", "HEAD").stdout.strip()
    bundle = pathlib.Path("/root/repository.bundle")
    run("/usr/bin/git", "-C", str(source), "bundle", "create", str(bundle), "HEAD")
    root = pathlib.Path("/var/lib/paws-check-input")
    for name in ("attempts", "commands"):
        path = root / name
        info = path.lstat()
        assert path.is_dir() and info.st_uid == runner.pw_uid and info.st_gid == input_gid and info.st_mode & 0o7777 == 0o2750
    attempt = root / "attempts" / ATTEMPT
    attempt.mkdir()
    os.chown(attempt, runner.pw_uid, input_gid)
    attempt.chmod(0o750)
    manifest = {"format": 1, "verificationAttemptId": ATTEMPT, "candidateSha": candidate, "bundleSha256": hashlib.sha256(bundle.read_bytes()).hexdigest()}
    for name, content in (("attempt.json", canonical(manifest)), ("repository.bundle", bundle.read_bytes())):
        path = attempt / name
        path.write_bytes(content)
        os.chown(path, runner.pw_uid, input_gid)
        path.chmod(0o640)
    client = "import json,socket,sys;s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(120);s.connect('/run/paws-runner-broker.sock');s.sendall((json.dumps({'operation':sys.argv[1],'executionId':sys.argv[2]})+'\\n').encode());b=b''\nwhile not b.endswith(b'\\n'): b+=s.recv(1024)\nprint(b.decode(),end='')"
    def daemon():
        os.setgroups([input_gid])
        os.setgid(runner.pw_gid)
        os.setuid(runner.pw_uid)
    def request(operation, execution):
        return subprocess.Popen(["/usr/bin/python3", "-I", "-c", client, operation, execution], preexec_fn=daemon, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    def response(process, timeout=120):
        output, error = process.communicate(timeout=timeout)
        assert process.returncode == 0, (output, error)
        return json.loads(output)
    def command(number, script, timeout=10000):
        execution = "01K" + "0" * 18 + str(number).zfill(5)
        base = "/var/lib/paws-check-attempts/" + ATTEMPT
        job = {"format": 1, "executionId": execution, "verificationAttemptId": ATTEMPT, "candidateSha": candidate, "argv": ["/usr/bin/python3", "-I", "-c", script], "cwd": base + "/workspace", "env": {"HOME": base + "/home", "TMPDIR": base + "/tmp", "PATH": "/opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "CI": "1"}, "timeoutMs": timeout}
        parent = root / "commands" / execution
        parent.mkdir()
        os.chown(parent, runner.pw_uid, input_gid)
        parent.chmod(0o750)
        path = parent / "job.json"
        path.write_bytes(canonical(job))
        os.chown(path, runner.pw_uid, input_gid)
        path.chmod(0o640)
        return execution, job
    observations = []
    receipts = []
    assert response(request("start-check-child", "01K00000000000000000000015")) == {"ok": False}
    root_request = subprocess.Popen(["/usr/bin/python3", "-I", "-c", client, "start-check", "01K00000000000000000000015"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert response(root_request) == {"ok": False}
    observations.append("peerUidSeparatesDaemonAdmissionFromRootChildControl")
    assert run("/usr/bin/systemctl", "show", "--property=RuntimeMaxUSec", "--value", "paws-check-witness@01K00000000000000000000998").stdout.strip() == "40min"
    def execute(number, script, timeout=10000):
        execution, job = command(number, script, timeout)
        assert response(request("start-check", execution)) == {"ok": True, "alreadyAdmitted": False}
        result_root = pathlib.Path("/var/lib/paws-check-results") / execution
        result_path = result_root / "result.json"
        deadline = time.monotonic() + 70
        while not result_path.exists():
            state = run("/usr/bin/systemctl", "show", "--property=ActiveState", "--value", "paws-check-witness@" + execution).stdout.strip()
            if time.monotonic() > deadline or state in ("failed", "inactive"):
                raise RuntimeError("Witness did not publish: " + run("/usr/bin/journalctl", "-u", "paws-runner-broker", "-u", "paws-check-witness@" + execution, "-u", "paws-check@" + execution, "--no-pager").stdout)
            time.sleep(0.05)
        assert response(request("stop-check", execution)) == {"ok": True}
        result = json.loads(result_path.read_bytes())
        assert result["inputSha256"] == hashlib.sha256(canonical(job)).hexdigest()
        assert result["candidateSha"] == candidate and result["verificationAttemptId"] == ATTEMPT
        assert result_path.stat().st_uid == 0
        message = pathlib.Path("/root/message")
        message.write_bytes(b"paws.runner-check-result.v1\0" + canonical(result))
        signature = pathlib.Path("/root/signature")
        signature.write_bytes(base64.b64decode((result_root / "verifier-signature").read_text(), validate=True))
        run("/usr/bin/openssl", "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", "/var/lib/paws-check-verifier-public.pem", "-in", str(message), "-sigfile", str(signature))
        receipts.append({"result": result, "signature": (result_root / "verifier-signature").read_text()})
        return result
    rejected_execution, _ = command(11, "raise RuntimeError('Failed admission executed')")
    collision = pathlib.Path("/var/lib/paws-check-control") / rejected_execution
    collision.mkdir(mode=0o700)
    assert response(request("start-check", rejected_execution))["ok"] is False
    assert response(request("stop-check", rejected_execution)) == {"ok": True}
    assert response(request("start-check", rejected_execution)) == {"ok": True, "alreadyAdmitted": True}
    observations.append("failedAdmissionConfirmedStopReleasesActiveSlot")
    setup = execute(1, "import pathlib;pathlib.Path('.paws-deps').mkdir();pathlib.Path('.paws-deps/installed').write_text('retained');pathlib.Path('tracked').write_text('setup dirt');print('setup')")
    assert setup["exitCode"] == 0 and setup["dirty"] is True and not setup["headMoved"]
    observations.append("setupDirtRecorded")
    preserved = execute(2, "import pathlib,os;assert pathlib.Path('.paws-deps/installed').read_text()=='retained';p=pathlib.Path('.git/config');p.write_text(p.read_text()+'\\n[core]\\n fsmonitor = !touch /var/lib/paws-check-attempts/01K00000000000000000000001/home/forged-fsmonitor\\n');os.write(1,'Unicode 🐕\\0\\n'.encode())")
    assert preserved["exitCode"] == 0 and not preserved["dirty"] and not preserved["headMoved"] and "🐕\0" in preserved["stdout"]
    assert not pathlib.Path("/var/lib/paws-check-attempts/01K00000000000000000000001/home/forged-fsmonitor").exists()
    observations.append("dependenciesAndDirtBaselinePreserved")
    failed = execute(3, "raise SystemExit(17)")
    assert failed["exitCode"] == 17 and failed["signal"] is None
    observations.append("actualNonzeroWaitStatus")
    signaled = execute(4, "import os,signal;os.kill(os.getpid(),signal.SIGTERM)")
    assert signaled["exitCode"] is None and signaled["signal"] == 15
    observations.append("actualSignalWaitStatus")
    timed = execute(5, "import os,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);p=os.fork();\nif p==0:\n os.setsid();time.sleep(60)\nelse:\n print(p,flush=True);time.sleep(60)", 3000)
    assert timed["timedOut"] and timed["signal"] == 9 and dead(int(timed["stdout"].strip()))
    observations.append("timeoutDetachedDescendantKilled")
    detached = execute(6, "import os,time;pid=os.fork();\nif pid==0:\n os.setsid();time.sleep(60)\nelse:\n print(pid,flush=True)")
    assert detached["exitCode"] == 0 and dead(int(detached["stdout"].strip()))
    observations.append("normalExitDescendantKilledBeforeResult")
    forged = execute(7, "import os,pathlib;os.environ['EXIT_CODE']='exited';os.environ['EXIT_STATUS']='0';\ntry:\n pathlib.Path('/var/lib/paws-check-control').iterdir().__next__();raise RuntimeError('private status readable')\nexcept PermissionError:\n pass\nraise SystemExit(23)")
    assert forged["exitCode"] == 23
    observations.append("forgedStatusAndEnvironmentDenied")
    populate = "import pathlib;pathlib.Path('tracked').write_text('original\\n');p=pathlib.Path('nested');p.mkdir(exist_ok=True);(p/'populated').write_text('fixture')"
    populated = execute(12, populate)
    assert populated["exitCode"] == 0 and populated["dirty"] is True
    observations.append("postCommandPopulatedSubmoduleIsDirty")
    witness_path = ASSETS / "check-witness.py"
    guarded_source = witness_path.read_text()
    guard = '        if before["status"] is None:\n            raise ValueError("Candidate metadata cannot admit a check")\n'
    assert guarded_source.count(guard) == 1
    baseline_source = guarded_source.replace(guard, "")
    cleaner = "import pathlib,shutil;shutil.rmtree('nested');pathlib.Path('nested').mkdir();pathlib.Path('../home/cleaner-launched').write_text('launched')"
    witness_path.write_text(baseline_source)
    try:
        cleaned = execute(13, cleaner)
        assert cleaned["exitCode"] == 0 and not cleaned["dirty"]
        assert pathlib.Path("/var/lib/paws-check-attempts/" + ATTEMPT + "/home/cleaner-launched").read_text() == "launched"
    finally:
        witness_path.write_text(guarded_source)
    observations.append("unguardedBeforeNullLaunchesCleaningChildAndReportsClean")
    marker = pathlib.Path("/var/lib/paws-check-attempts/" + ATTEMPT + "/home/cleaner-launched")
    marker.unlink()
    run("/usr/bin/python3", "-I", "-c", populate, cwd="/var/lib/paws-check-attempts/" + ATTEMPT + "/workspace", preexec_fn=ordinary_check)
    execution, _ = command(14, cleaner)
    response(request("start-check", execution))
    deadline = time.monotonic() + 30
    while run("/usr/bin/systemctl", "show", "--property=ActiveState", "--value", "paws-check-witness@" + execution).stdout.strip() not in ("failed", "inactive"):
        if time.monotonic() > deadline:
            raise RuntimeError("Populated-submodule refusal did not finish")
        time.sleep(0.05)
    assert response(request("stop-check", execution)) == {"ok": True}
    assert not marker.exists()
    assert not (pathlib.Path("/var/lib/paws-check-broker") / (execution + ".child")).exists()
    assert not (pathlib.Path("/var/lib/paws-check-results") / execution / "result.json").exists()
    assert pathlib.Path("/var/lib/paws-check-attempts/" + ATTEMPT + "/workspace/nested/populated").read_text() == "fixture"
    observations.append("guardedBeforeNullRefusesWithoutChildLaunchOrResult")
    run("/usr/bin/python3", "-I", "-c", "import shutil,pathlib;shutil.rmtree('nested');pathlib.Path('nested').mkdir()", cwd="/var/lib/paws-check-attempts/" + ATTEMPT + "/workspace", preexec_fn=ordinary_check)
    moved = execute(8, "import pathlib;pathlib.Path('.git/HEAD').write_text('0'*40+'\\n')")
    assert moved["headMoved"] is True
    observations.append("actualHeadMoveDetected")
    execution, _ = command(9, "import pathlib,time;pathlib.Path('/var/lib/paws-check-attempts/" + ATTEMPT + "/home/cancel-pid').write_text(str(__import__('os').getpid()));time.sleep(60)")
    override = pathlib.Path("/etc/systemd/system/paws-check-witness@" + execution + ".service.d")
    override.mkdir()
    (override / "held.conf").write_text("[Service]\nExecStartPost=/usr/bin/sleep 20\n")
    run("/usr/bin/systemctl", "daemon-reload")
    start = request("start-check", execution)
    marker = pathlib.Path("/var/lib/paws-check-attempts") / ATTEMPT / "home/cancel-pid"
    deadline = time.monotonic() + 20
    while not marker.exists():
        if time.monotonic() > deadline:
            raise RuntimeError("Held check did not run: " + run("/usr/bin/journalctl", "-u", "paws-check-witness@" + execution, "--no-pager").stdout)
        time.sleep(0.05)
    started = time.monotonic()
    stopped = request("stop-check", execution)
    while not dead(int(marker.read_text())):
        if time.monotonic() - started >= 5:
            raise RuntimeError("Untrusted child survived immediate stop fence")
        time.sleep(0.01)
    death_elapsed = time.monotonic() - started
    assert response(stopped, 60) == {"ok": True}
    elapsed = time.monotonic() - started
    assert elapsed < 60
    assert response(start, 10)["ok"] is False
    assert not (pathlib.Path("/var/lib/paws-check-results") / execution / "result.json").exists()
    late_start = subprocess.run(["/usr/bin/systemctl", "start", "paws-check@" + execution], capture_output=True, check=False)
    assert late_start.returncode != 0
    assert response(request("start-check", execution)) == {"ok": True, "alreadyAdmitted": True}
    observations.append("concurrentStopFencesHeldStartWithoutResult")
    hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in ASSETS.iterdir() if path.is_file()}
    print("PAWS_CHECK_WITNESS_VM_PROOF " + json.dumps({"passed": True, "sourceHashes": hashes, "observations": observations, "runnerUid": runner.pw_uid, "checkUid": check.pw_uid, "stopElapsedMs": round(elapsed * 1000), "childDeathElapsedMs": round(death_elapsed * 1000), "verifierFingerprint": identity["fingerprint"], "identity": identity, "receipts": receipts, "gitVersion": run("/usr/bin/git", "--version").stdout.strip()}), flush=True)


if __name__ == "__main__":
    main()
