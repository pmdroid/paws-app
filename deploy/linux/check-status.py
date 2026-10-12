import json
import os
import pathlib
import re
import signal
import stat
import sys


EXECUTION_ID = re.compile(r"[0-7][0-9A-HJKMNP-TV-Z]{25}\Z")
CONTROL = "/var/lib/paws-check-control"


def open_directory(parent, name):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)


def private_directory(descriptor):
    info = os.fstat(descriptor)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("Unsafe check status directory")


def read_identity(directory):
    descriptor = os.open("identity.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 4096:
            raise ValueError("Unsafe check status identity")
        content = os.read(descriptor, 4097)
        if len(content) > 4096:
            raise ValueError("Check status identity exceeds size limit")
        identity = json.loads(content)
    finally:
        os.close(descriptor)
    if not isinstance(identity, dict) or set(identity) != {"format", "executionId", "verificationAttemptId", "candidateSha", "inputSha256"} or identity["format"] != 1:
        raise ValueError("Invalid check status identity")
    for key in ("executionId", "verificationAttemptId"):
        if not isinstance(identity[key], str) or not EXECUTION_ID.fullmatch(identity[key]):
            raise ValueError("Invalid check status identifier")
    for key, length in (("candidateSha", 40), ("inputSha256", 64)):
        if not isinstance(identity[key], str) or not re.fullmatch(r"[a-f0-9]{" + str(length) + r"}", identity[key]):
            raise ValueError("Invalid check status digest")
    return identity


def wait_status():
    kind = os.environ.get("EXIT_CODE")
    status = os.environ.get("EXIT_STATUS", "")
    if kind == "exited" and re.fullmatch(r"[0-9]{1,3}", status) and int(status) <= 255:
        return int(status), None
    if kind in ("killed", "dumped"):
        try:
            number = int(signal.Signals["SIG" + status])
        except KeyError:
            match = re.fullmatch(r"RTMIN\+([0-9]{1,2})", status)
            if not match:
                raise ValueError("Invalid PID1 signal")
            number = signal.SIGRTMIN + int(match[1])
        if 1 <= number <= signal.SIGRTMAX:
            return None, number
    raise ValueError("PID1 did not provide command wait status")


def main():
    capabilities = next(line.split()[1] for line in pathlib.Path("/proc/self/status").read_text().splitlines() if line.startswith("CapEff:"))
    if os.getuid() != 0 or int(capabilities, 16) != 0 or len(sys.argv) != 2 or not EXECUTION_ID.fullmatch(sys.argv[1]):
        raise ValueError("Zero-capability root finalizer required")
    root = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    directory = None
    try:
        for part in CONTROL.split("/")[1:]:
            following = open_directory(root, part)
            os.close(root)
            root = following
        private_directory(root)
        directory = open_directory(root, sys.argv[1])
        private_directory(directory)
        identity = read_identity(directory)
        if identity["executionId"] != sys.argv[1]:
            raise ValueError("Check status execution mismatch")
        invocation = os.environ.get("INVOCATION_ID", "")
        if not re.fullmatch(r"[a-f0-9]{32}", invocation):
            raise ValueError("Invalid PID1 invocation")
        service_result = os.environ.get("SERVICE_RESULT")
        if service_result not in ("success", "exit-code", "signal", "core-dump", "timeout", "watchdog", "oom-kill", "resources", "protocol", "start-limit-hit"):
            raise ValueError("Invalid PID1 service result")
        exit_code, command_signal = wait_status()
        result = {**identity, "serviceResult": service_result, "exitCode": exit_code, "signal": command_signal, "invocationId": invocation}
        descriptor = os.open("status.pending", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(result, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.rename("status.pending", "status.json", src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        if directory is not None:
            os.close(directory)
        os.close(root)


if __name__ == "__main__":
    main()
