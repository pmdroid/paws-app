import json
import os
import pwd
import re
import stat
import sys


EXECUTION_ID = re.compile(r"[0-7][0-9A-HJKMNP-TV-Z]{25}\Z")
WORK_ROOT = "/var/lib/paws-check-attempts"


def text(value, limit):
    return isinstance(value, str) and "\0" not in value and len(value.encode("utf-8")) <= limit


def directory(parent, name):
    return os.open(name, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)


def validate_directory(descriptor, uid, gid, mode):
    info = os.fstat(descriptor)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:
        raise ValueError("Unsafe check workspace")


def main():
    account = pwd.getpwnam("paws-check")
    if os.getuid() != account.pw_uid or account.pw_uid == 0 or len(sys.argv) != 2 or not EXECUTION_ID.fullmatch(sys.argv[1]):
        raise ValueError("Fixed check identity required")
    content = sys.stdin.buffer.read(262145)
    if len(content) > 262144:
        raise ValueError("Check input exceeds size limit")
    job = json.loads(content)
    if not isinstance(job, dict) or set(job) != {"executionId", "verificationAttemptId", "argv", "cwd", "env"} or job["executionId"] != sys.argv[1] or not isinstance(job["verificationAttemptId"], str) or not EXECUTION_ID.fullmatch(job["verificationAttemptId"]):
        raise ValueError("Invalid check identity")
    if not isinstance(job["argv"], list) or not 1 <= len(job["argv"]) <= 128 or not all(text(value, 8192) for value in job["argv"]) or not job["argv"][0]:
        raise ValueError("Invalid check command")
    if not isinstance(job["env"], dict) or len(job["env"]) > 128 or not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", key) and text(value, 8192) for key, value in job["env"].items()):
        raise ValueError("Invalid check environment")
    attempt = WORK_ROOT + "/" + job["verificationAttemptId"]
    workspace = attempt + "/workspace"
    if not text(job["cwd"], 4096) or not (job["cwd"] == workspace or job["cwd"].startswith(workspace + "/")) or job["cwd"] != os.path.normpath(job["cwd"]):
        raise ValueError("Invalid check working directory")
    descriptor = os.open("/", os.O_PATH | os.O_DIRECTORY)
    try:
        for part in WORK_ROOT.split("/")[1:]:
            following = directory(descriptor, part)
            os.close(descriptor)
            descriptor = following
        validate_directory(descriptor, 0, account.pw_gid, 0o750)
        following = directory(descriptor, job["verificationAttemptId"])
        os.close(descriptor)
        descriptor = following
        validate_directory(descriptor, 0, account.pw_gid, 0o750)
        home = directory(descriptor, "home")
        try:
            validate_directory(home, account.pw_uid, account.pw_gid, 0o700)
        finally:
            os.close(home)
        following = directory(descriptor, "workspace")
        os.close(descriptor)
        descriptor = following
        validate_directory(descriptor, account.pw_uid, account.pw_gid, 0o700)
        for part in job["cwd"][len(workspace):].split("/"):
            if part:
                following = directory(descriptor, part)
                os.close(descriptor)
                descriptor = following
        os.fchdir(descriptor)
    finally:
        os.close(descriptor)
    stdin = os.open("/dev/null", os.O_RDONLY)
    try:
        os.dup2(stdin, 0)
    finally:
        os.close(stdin)
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", **job["env"], "HOME": attempt + "/home"}
    os.execvpe(job["argv"][0], job["argv"], environment)


if __name__ == "__main__":
    main()
