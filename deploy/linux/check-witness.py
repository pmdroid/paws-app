import codecs
import fcntl
import grp
import hashlib
import importlib.util
import json
import os
import pathlib
import pwd
import re
import selectors
import socket
import stat
import subprocess
import sys
import time


IDENTIFIER = re.compile(r"[0-7][0-9A-HJKMNP-TV-Z]{25}\Z")
CONTROL = "/var/lib/paws-check-control"
INPUT = "/var/lib/paws-check-input/commands"
PRIVATE = "/var/lib/paws-check-metadata"
RECEIPTS = "/var/lib/paws-check-broker"
RESULTS = "/var/lib/paws-check-results"
ASSETS = "/opt/paws-runner/current/deploy/linux"


def valid_exclusions(folders):
    return isinstance(folders, list) and len(folders) <= 128 and len(json.dumps(folders, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= 32768 and all(isinstance(folder, str) and 0 < len(folder.encode("utf-8")) <= 1024 and "\\" not in folder and all(ord(char) >= 32 and ord(char) != 127 for char in folder) and all(part not in ("", ".", "..") and part.lower() != ".git" for part in folder.split("/")) for folder in folders)


def directory(path):
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split("/"):
            if not part:
                continue
            if part in (".", ".."):
                raise ValueError("Invalid witness path")
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def validate_directory(descriptor, uid, gid, mode):
    info = os.fstat(descriptor)
    if info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:
        raise ValueError("Unsafe witness directory")


def read_file(parent, name, uid, gid, mode, limit):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode or info.st_size > limit:
            raise ValueError("Unsafe witness file")
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            content = stream.read(limit + 1)
        if len(content) > limit:
            raise ValueError("Witness file exceeds size limit")
        return content
    finally:
        os.close(descriptor)


def exclusive_file(parent, name, content):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.fsync(parent)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def bounded_text(value, maximum):
    return isinstance(value, str) and "\0" not in value and len(value.encode("utf-8")) <= maximum


def read_input(execution_id, runner_uid, input_gid):
    parent = directory(INPUT + "/" + execution_id)
    try:
        validate_directory(parent, runner_uid, input_gid, 0o750)
        content = read_file(parent, "job.json", runner_uid, input_gid, 0o640, 262144)
    finally:
        os.close(parent)
    job = json.loads(content)
    if not isinstance(job, dict) or set(job) - {"checkoutExclusions"} != {"format", "executionId", "verificationAttemptId", "candidateSha", "argv", "cwd", "env", "timeoutMs"} or type(job["format"]) is not int or job["format"] != 1 or job["executionId"] != execution_id or not isinstance(job["verificationAttemptId"], str) or not IDENTIFIER.fullmatch(job["verificationAttemptId"]) or not isinstance(job["candidateSha"], str) or not re.fullmatch(r"[a-f0-9]{40}", job["candidateSha"]):
        raise ValueError("Invalid witness command identity")
    if not isinstance(job["argv"], list) or not 1 <= len(job["argv"]) <= 128 or not all(bounded_text(value, 8192) for value in job["argv"]) or not job["argv"][0] or type(job["timeoutMs"]) is not int or not 1 <= job["timeoutMs"] <= 900000:
        raise ValueError("Invalid witness command bounds")
    if not valid_exclusions(job.get("checkoutExclusions", [])):
        raise ValueError("Invalid checkout exclusions")
    attempt = "/var/lib/paws-check-attempts/" + job["verificationAttemptId"]
    workspace = attempt + "/workspace"
    if not bounded_text(job["cwd"], 4096) or not (job["cwd"] == workspace or job["cwd"].startswith(workspace + "/")) or job["cwd"] != os.path.normpath(job["cwd"]):
        raise ValueError("Invalid witness working directory")
    environment = {"HOME": attempt + "/home", "TMPDIR": attempt + "/tmp", "PATH": "/opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "CI": "1"}
    if job["env"] != environment or canonical(job) != content:
        raise ValueError("Witness requires the canonical clean command input")
    return job, hashlib.sha256(content).hexdigest()


def control(operation, execution_id):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(120 if operation == "start-check-child" else 60)
    try:
        connection.connect("/run/paws-runner-broker.sock")
        connection.sendall(canonical({"operation": operation, "executionId": execution_id}) + b"\n")
        content = bytearray()
        while not content.endswith(b"\n"):
            chunk = connection.recv(1025 - len(content))
            if not chunk or len(content) + len(chunk) > 1024:
                raise ValueError("Invalid check broker acknowledgement")
            content.extend(chunk)
        response = json.loads(content)
        if not isinstance(response, dict) or response.get("ok") is not True or response.get("alreadyAdmitted", False) is not False:
            raise ValueError("Check broker did not confirm operation")
    finally:
        connection.close()


def metadata(mode, attempt, candidate, check, input_gid, metadata_gid, exclusions):
    def identity():
        os.setgroups([check.pw_gid, input_gid])
        os.setgid(metadata_gid)
        os.setuid(check.pw_uid)
    result = subprocess.run(["/usr/bin/python3", "-I", "-B", ASSETS + "/check-metadata.py", mode, attempt, candidate, hashlib.sha256(canonical(exclusions)).hexdigest()], preexec_fn=identity, stdin=subprocess.DEVNULL, capture_output=True, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/var/empty"}, timeout=450, check=False)
    if result.returncode != 0:
        raise ValueError("Trusted metadata inspection failed: " + result.stderr[:8192].decode("utf-8", "replace"))
    if len(result.stdout) > 131072:
        raise ValueError("Metadata snapshot exceeds size limit")
    snapshot = json.loads(result.stdout)
    if not isinstance(snapshot, dict) or set(snapshot) != {"status", "headMoved"} or type(snapshot["headMoved"]) is not bool or (snapshot["status"] is not None and not isinstance(snapshot["status"], str)):
        raise ValueError("Invalid trusted metadata snapshot")
    return snapshot


class Output:
    def __init__(self):
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.chunks = []
        self.size = 0
        self.truncated = False

    def append(self, content, final=False):
        text = self.decoder.decode(content, final=final)
        encoded = text.encode("utf-8")
        remaining = 1048576 - self.size
        if len(encoded) > remaining:
            self.truncated = True
            text = encoded[:remaining].decode("utf-8", "ignore")
        if text:
            self.chunks.append(text)
        self.size += len(text.encode("utf-8"))

    def text(self):
        return "".join(self.chunks)


def execute(parent, job):
    streams = selectors.DefaultSelector()
    keepers = []
    output = [Output(), Output()]
    try:
        for index, name in enumerate(("stdout", "stderr")):
            os.mkfifo(name, mode=0o600, dir_fd=parent)
            descriptor = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
            streams.register(descriptor, selectors.EVENT_READ, index)
            keepers.append(os.open(name, os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent))
        child = {key: job[key] for key in ("executionId", "verificationAttemptId", "argv", "cwd", "env")}
        exclusive_file(parent, "child.json", canonical(child))
        started = time.monotonic()
        control("start-check-child", job["executionId"])
        timed_out = False
        while True:
            for key, _ in streams.select(0.05):
                chunk = os.read(key.fd, 16384)
                output[key.data].append(chunk, final=not chunk)
                if not chunk:
                    streams.unregister(key.fd)
                    os.close(key.fd)
            if time.monotonic() - started >= job["timeoutMs"] / 1000:
                timed_out = True
                break
            try:
                os.stat("status.json", dir_fd=parent, follow_symlinks=False)
                break
            except FileNotFoundError:
                pass
        control("stop-check-child", job["executionId"])
        for descriptor in keepers:
            os.close(descriptor)
        keepers = []
        for _ in range(130):
            if not streams.get_map():
                break
            for key, _ in streams.select(0.05):
                chunk = os.read(key.fd, 16384)
                output[key.data].append(chunk, final=not chunk)
                if not chunk:
                    streams.unregister(key.fd)
                    os.close(key.fd)
        if streams.get_map():
            raise ValueError("Check output remained open after cgroup teardown")
        status = json.loads(read_file(parent, "status.json", 0, 0, 0o600, 4096))
        return status, timed_out, (time.monotonic() - started) * 1000, output
    finally:
        for descriptor in keepers:
            os.close(descriptor)
        for key in list(streams.get_map().values()):
            os.close(key.fd)
        streams.close()


def publish_result(result, runner_gid):
    root = directory(RESULTS)
    parent = None
    receipt_root = None
    lock = None
    try:
        validate_directory(root, 0, runner_gid, 0o750)
        os.mkdir(result["executionId"], mode=0o700, dir_fd=root)
        parent = os.open(result["executionId"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        os.fchown(parent, -1, runner_gid)
        os.fchmod(parent, 0o750)
        exclusive_file(parent, "result.pending", canonical(result))
        pending = os.open("result.pending", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            os.fchown(pending, -1, runner_gid)
            os.fchmod(pending, 0o640)
            os.fsync(pending)
        finally:
            os.close(pending)
        specification = importlib.util.spec_from_file_location("paws_verifier", ASSETS + "/check-verifier.py")
        verifier = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(verifier)
        expected = {key: result[key] for key in ("format", "executionId", "verificationAttemptId", "candidateSha", "inputSha256")}
        signature = verifier.sign_pending_result(parent, expected, runner_gid)
        exclusive_file(parent, "verifier-signature.pending", signature.encode("ascii"))
        signed = os.open("verifier-signature.pending", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            os.fchown(signed, -1, runner_gid)
            os.fchmod(signed, 0o640)
            os.fsync(signed)
        finally:
            os.close(signed)
        receipt_root = directory(RECEIPTS)
        validate_directory(receipt_root, 0, 0, 0o700)
        lock = os.open(result["executionId"] + ".lock", os.O_RDWR | os.O_NOFOLLOW, dir_fd=receipt_root)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("Unsafe check publication lock")
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            os.stat(result["executionId"] + ".stopped", dir_fd=receipt_root, follow_symlinks=False)
            raise ValueError("Interrupted check cannot publish completion")
        except FileNotFoundError:
            pass
        os.rename("verifier-signature.pending", "verifier-signature", src_dir_fd=parent, dst_dir_fd=parent)
        os.rename("result.pending", "result.json", src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
        os.fsync(root)
    finally:
        for descriptor in (lock, receipt_root, parent, root):
            if descriptor is not None:
                os.close(descriptor)


def main():
    check = pwd.getpwnam("paws-check")
    runner = pwd.getpwnam("paws-runner")
    input_gid = grp.getgrnam("paws-check-input").gr_gid
    metadata_gid = grp.getgrnam("paws-check-metadata").gr_gid
    capabilities = next(line.split()[1] for line in pathlib.Path("/proc/self/status").read_text().splitlines() if line.startswith("CapEff:"))
    if os.getuid() != 0 or int(capabilities, 16) != 192 or len(sys.argv) != 2 or not IDENTIFIER.fullmatch(sys.argv[1]) or check.pw_uid in (0, runner.pw_uid) or runner.pw_uid == 0:
        raise ValueError("Fixed trusted witness identity required")
    execution_id = sys.argv[1]
    root = directory(CONTROL)
    parent = None
    active = None
    attempt = None
    try:
        validate_directory(root, 0, 0, 0o700)
        active = os.open("active.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=root)
        info = os.fstat(active)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("Unsafe global check lock")
        fcntl.flock(active, fcntl.LOCK_EX | fcntl.LOCK_NB)
        parent = os.open(execution_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        validate_directory(parent, 0, 0, 0o700)
        identity = json.loads(read_file(parent, "identity.json", 0, 0, 0o600, 4096))
        job, digest = read_input(execution_id, runner.pw_uid, input_gid)
        expected = {"format": 1, "executionId": execution_id, "verificationAttemptId": job["verificationAttemptId"], "candidateSha": job["candidateSha"], "inputSha256": digest}
        if identity != expected:
            raise ValueError("Witness command identity mismatch")
        attempt = directory(PRIVATE + "/" + job["verificationAttemptId"])
        validate_directory(attempt, 0, metadata_gid, 0o750)
        try:
            read_file(attempt, "initialized", 0, 0, 0o600, 0)
        except FileNotFoundError:
            exclusive_file(attempt, "initializing", b"")
            metadata("init", job["verificationAttemptId"], job["candidateSha"], check, input_gid, metadata_gid, job.get("checkoutExclusions", []))
            exclusive_file(attempt, "initialized", b"")
        before = metadata("inspect", job["verificationAttemptId"], job["candidateSha"], check, input_gid, metadata_gid, job.get("checkoutExclusions", []))
        if before["status"] is None:
            raise ValueError("Candidate metadata cannot admit a check")
        status, timed_out, duration, output = execute(parent, job)
        if any(status.get(key) != value for key, value in expected.items()) or set(status) != {*expected, "serviceResult", "exitCode", "signal", "invocationId"}:
            raise ValueError("Trusted PID1 status identity mismatch")
        exit_code, command_signal = status["exitCode"], status["signal"]
        if not ((type(exit_code) is int and 0 <= exit_code <= 255 and command_signal is None) or (exit_code is None and type(command_signal) is int and 1 <= command_signal <= 64)):
            raise ValueError("Invalid trusted PID1 wait status")
        after = metadata("inspect", job["verificationAttemptId"], job["candidateSha"], check, input_gid, metadata_gid, job.get("checkoutExclusions", []))
        publish_result({**expected, "exitCode": exit_code, "signal": command_signal, "timedOut": timed_out or status["serviceResult"] == "timeout", "stdout": output[0].text(), "stderr": output[1].text(), "stdoutTruncated": output[0].truncated, "stderrTruncated": output[1].truncated, "durationMs": int(duration), "dirty": new_dirt(before["status"], after["status"]), "headMoved": after["headMoved"]}, runner.pw_gid)
    finally:
        for descriptor in (attempt, active, parent, root):
            if descriptor is not None:
                os.close(descriptor)


def new_dirt(before, after):
    if after is None:
        return True
    if not after:
        return False
    return before is None or before != after


if __name__ == "__main__":
    main()
