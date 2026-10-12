import hashlib
import json
import os
import pathlib
import pwd
import select
import stat
import subprocess
import time


ASSETS = pathlib.Path("/opt/paws-runner/current/deploy/linux")
CONTROL = pathlib.Path("/var/lib/paws-check-control")
ATTEMPT = "01K00000000000000000000000"


def run(*args):
    return subprocess.run(args, capture_output=True, text=True, check=True)


def write_private(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)


def main():
    if os.getuid() != 0 or pathlib.Path("/proc/1/comm").read_text().strip() != "systemd":
        raise RuntimeError("Disposable systemd VM required")
    account_config = pathlib.Path("/root/paws-check-proof.sysusers")
    account_config.write_text('u paws-check - "Paws local check proof" /var/lib/paws-check /usr/sbin/nologin\n')
    run("/usr/bin/systemd-sysusers", str(account_config))
    account = pwd.getpwnam("paws-check")
    CONTROL.mkdir(mode=0o700)
    for name in ("/var/lib/paws-check-attempts", "/var/lib/paws-check"):
        path = pathlib.Path(name)
        path.mkdir(mode=0o750)
        os.chown(path, 0, account.pw_gid)
    attempt = pathlib.Path("/var/lib/paws-check-attempts") / ATTEMPT
    attempt.mkdir(mode=0o750)
    os.chown(attempt, 0, account.pw_gid)
    for name in ("home", "workspace"):
        directory = attempt / name
        directory.mkdir(mode=0o700)
        os.chown(directory, account.pw_uid, account.pw_gid)
    unit_path = pathlib.Path("/etc/systemd/system/paws-check@.service")
    unit_path.write_text('[Unit]\nDescription=Paws untrusted verification command %i\n\n[Service]\nType=exec\nUser=paws-check\nGroup=paws-check\nEnvironment=HOME=/var/lib/paws-check\nWorkingDirectory=/var/lib/paws-check\nStandardInput=file:/var/lib/paws-check-control/%i/child.json\nStandardOutput=file:/var/lib/paws-check-control/%i/stdout\nStandardError=file:/var/lib/paws-check-control/%i/stderr\nExecStart=/usr/bin/python3 -I -B /opt/paws-runner/current/deploy/linux/check-child.py %i\nExecStopPost=!/usr/bin/python3 -I -B /opt/paws-runner/current/deploy/linux/check-status.py %i\nKillMode=control-group\nTimeoutStartSec=30s\nTimeoutStopSec=5s\nRuntimeMaxSec=900s\nSendSIGKILL=yes\nUMask=0077\nNoNewPrivileges=yes\nCapabilityBoundingSet=\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nLockPersonality=yes\nReadWritePaths=/var/lib/paws-check-attempts /var/lib/paws-check-control\nInaccessiblePaths=-/var/lib/paws-runner -/var/lib/paws-agent -/var/lib/paws-runner-broker -/var/lib/paws-check-input -/var/lib/paws-check-results -/run/user -/run/dbus\n')
    program = '''import json,os,signal,sys,time
case=sys.argv[1]
if case=='normal':
    print(json.dumps({'uid':os.getuid(),'home':os.environ['HOME'],'rootMarkerAbsent':'PAWS_CHECK_ROOT_MARKER' not in os.environ,'explicitEnv':os.environ.get('PAWS_CHECK_PROBE')}),flush=True)
if case=='forged':
    os.environ.update(SERVICE_RESULT='success',EXIT_CODE='exited',EXIT_STATUS='0')
    try:
        open(sys.argv[2]+'/status.json','w').write('forged')
        raise RuntimeError('Child forged status')
    except PermissionError:
        print('writeDenied',flush=True)
    sys.exit(23)
if case=='nonzero':
    sys.exit(17)
if case=='signal':
    os.kill(os.getpid(),signal.SIGTERM)
if case=='timeout':
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    while True:
        time.sleep(1)
if case=='descendant':
    pid=os.fork()
    if pid==0:
        os.setsid()
        signal.signal(signal.SIGTERM,signal.SIG_IGN)
        while True:
            time.sleep(1)
    print(pid,flush=True)
'''
    observations = []
    for number, case in enumerate(("normal", "nonzero", "signal", "timeout", "forged", "descendant"), 1):
        execution_id = "01K" + str(number).zfill(23)
        context = CONTROL / execution_id
        context.mkdir(mode=0o700)
        identity = {"format": 1, "executionId": execution_id, "verificationAttemptId": ATTEMPT, "candidateSha": "a" * 40, "inputSha256": "b" * 64}
        write_private(context / "identity.json", identity)
        write_private(context / "child.json", {"executionId": execution_id, "verificationAttemptId": ATTEMPT, "argv": ["/usr/bin/python3", "-I", "-c", program, case, str(context)], "cwd": str(attempt / "workspace"), "env": {"PAWS_CHECK_PROBE": "present"}})
        descriptors = []
        streams = {}
        for name in ("stdout", "stderr"):
            os.mkfifo(context / name, mode=0o600)
            descriptor = os.open(context / name, os.O_RDONLY | os.O_NONBLOCK)
            descriptors.append(descriptor)
            streams[descriptor] = bytearray()
        dropin = pathlib.Path("/etc/systemd/system") / f"paws-check@{execution_id}.service.d"
        dropin.mkdir()
        (dropin / "proof.conf").write_text("[Service]\nEnvironment=PAWS_CHECK_ROOT_MARKER=fixture-root-environment\n" + ("RuntimeMaxSec=2s\n" if case == "timeout" else ""))
        run("/usr/bin/systemctl", "daemon-reload")
        started = time.monotonic()
        try:
            run("/usr/bin/systemctl", "start", f"paws-check@{execution_id}.service")
            status_path = context / "status.json"
            deadline = time.monotonic() + 20
            while not status_path.exists():
                if time.monotonic() > deadline:
                    raise RuntimeError("Missing trusted status: " + case)
                for descriptor in select.select(descriptors, [], [], 0.1)[0]:
                    try:
                        content = os.read(descriptor, 65536)
                    except BlockingIOError:
                        continue
                    if len(streams[descriptor]) + len(content) > 1_048_576:
                        raise RuntimeError("Proof output exceeded limit")
                    streams[descriptor].extend(content)
            run("/usr/bin/systemctl", "stop", f"paws-check@{execution_id}.service")
            for descriptor in descriptors:
                while True:
                    try:
                        content = os.read(descriptor, 65536)
                    except BlockingIOError:
                        break
                    if not content:
                        break
                    streams[descriptor].extend(content)
            status = json.loads(status_path.read_bytes())
            for key, value in identity.items():
                assert status[key] == value, (case, status)
            expected = {"normal": ("success", 0, None), "nonzero": ("exit-code", 17, None), "signal": ("success", None, 15), "timeout": ("timeout", None, 9), "forged": ("exit-code", 23, None), "descendant": ("timeout", 0, None)}[case]
            assert (status["serviceResult"], status["exitCode"], status["signal"]) == expected, (case, status)
            info = status_path.stat()
            assert info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o600
            stdout = streams[descriptors[0]].decode()
            if case == "normal":
                assert json.loads(stdout) == {"uid": account.pw_uid, "home": str(attempt / "home"), "rootMarkerAbsent": True, "explicitEnv": "present"}
            if case == "forged":
                assert "writeDenied" in stdout
            if case == "descendant":
                child = pathlib.Path("/proc") / str(int(stdout.strip())) / "stat"
                assert not child.exists() or child.read_text().rsplit(")", 1)[1].split()[0] == "Z"
            status.update(case=case, durationMs=round((time.monotonic() - started) * 1000), zeroCapabilityGuardPassed=True)
            observations.append(status)
        finally:
            for descriptor in descriptors:
                os.close(descriptor)
    hashes = {name: hashlib.sha256((ASSETS / name).read_bytes()).hexdigest() for name in ("check-child.py", "check-status.py")}
    print("PAWS_CHECK_STATUS_PROOF " + json.dumps({"passed": True, "pid1": "systemd", "checkUid": account.pw_uid, "sourceHashes": hashes, "timeoutProofOverrideSeconds": 2, "rootEnvironmentMarkerInjected": True, "observations": observations}), flush=True)


if __name__ == "__main__":
    main()
