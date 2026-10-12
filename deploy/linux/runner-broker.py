import json
import fcntl
import importlib.util
from contextlib import contextmanager
import grp
import os
import pwd
import re
import socket
import stat
import struct
import subprocess
import sys
import threading


EXECUTION_ID = re.compile(r"[0-7][0-9A-HJKMNP-TV-Z]{25}\Z")
SPOOL = "/var/lib/paws-runner-spool"
UNIT = "/etc/systemd/system/paws-agent@.service"
RECEIPTS = "/var/lib/paws-runner-broker"
RESULTS = "/var/lib/paws-agent-results"


def open_directory(path):
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split("/"):
            if not part:
                continue
            if part in (".", ".."):
                raise ValueError("Invalid directory")
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def validate_directory(descriptor, runner_uid, agent_gid, root=False):
    info = os.fstat(descriptor)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != runner_uid or info.st_gid != agent_gid or stat.S_IMODE(info.st_mode) not in ((0o750, 0o2750) if root else (0o750,)):
        raise ValueError("Unsafe job directory")


def validate_job(execution_id, runner_uid, agent_gid):
    root = open_directory(SPOOL)
    directory = None
    descriptor = None
    try:
        validate_directory(root, runner_uid, agent_gid, True)
        directory = os.open(execution_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        validate_directory(directory, runner_uid, agent_gid)
        descriptor = os.open("job.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != runner_uid or info.st_gid != agent_gid or stat.S_IMODE(info.st_mode) != 0o640 or info.st_size > 524288:
            raise ValueError("Unsafe job file")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            content = stream.read(524289)
            if len(content) > 524288:
                raise ValueError("Job file exceeds size limit")
            job = json.loads(content)
        if not isinstance(job, dict) or set(job) != {"executionId", "command"} or job["executionId"] != execution_id or not isinstance(job["command"], dict) or job["command"].get("type") not in ("run", "review", "probe", "login_check"):
            raise ValueError("Invalid job")
        if job["command"]["type"] in ("run", "review"):
            descriptor = os.open("repository.bundle", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != runner_uid or info.st_gid != agent_gid or stat.S_IMODE(info.st_mode) != 0o640 or not 0 < info.st_size <= 536870912:
                raise ValueError("Unsafe repository bundle")
    finally:
        for opened in (descriptor, directory, root):
            if opened is not None:
                os.close(opened)


def validate_unit():
    descriptor = os.open(UNIT, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("Unsafe worker unit")
    finally:
        os.close(descriptor)


@contextmanager
def lifecycle(execution_id, receipts=RECEIPTS):
    directory = open_directory(receipts)
    descriptor = None
    try:
        info = os.fstat(directory)
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("Unsafe broker receipts")
        descriptor = os.open(execution_id + ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        validate_receipt(descriptor)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield directory
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(directory)


def validate_receipt(descriptor):
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("Unsafe broker receipt")


def mark_once(directory, name):
    try:
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    except FileExistsError:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            validate_receipt(descriptor)
            return False
        finally:
            os.close(descriptor)
    try:
        os.fsync(descriptor)
        os.fsync(directory)
        return True
    finally:
        os.close(descriptor)


def stopped(directory, execution_id):
    try:
        descriptor = os.open(execution_id + ".stopped", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return False
    try:
        validate_receipt(descriptor)
        return True
    finally:
        os.close(descriptor)


def admit_once(execution_id):
    with lifecycle(execution_id) as directory:
        return mark_once(directory, execution_id)


def fence(execution_id):
    with lifecycle(execution_id) as directory:
        mark_once(directory, execution_id + ".stopped")
        mark_once(directory, execution_id)


def guard(execution_id):
    if os.getuid() != 0 or not EXECUTION_ID.fullmatch(execution_id):
        return False
    capabilities = next(line.split()[1] for line in open("/proc/self/status") if line.startswith("CapEff:"))
    if int(capabilities, 16) != 0:
        return False
    with lifecycle(execution_id) as directory:
        if stopped(directory, execution_id):
            return False
        descriptor = os.open(execution_id, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            validate_receipt(descriptor)
        finally:
            os.close(descriptor)
        return mark_once(directory, execution_id + ".launched")


def prepare_results(execution_id, agent_uid, results_gid):
    root = open_directory(RESULTS)
    descriptor = None
    try:
        info = os.fstat(root)
        if info.st_uid != 0 or info.st_gid != results_gid or stat.S_IMODE(info.st_mode) != 0o750:
            raise ValueError("Unsafe results root")
        os.mkdir(execution_id, mode=0o700, dir_fd=root)
        descriptor = os.open(execution_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        os.fchmod(descriptor, 0o750)
        os.fchown(descriptor, agent_uid, results_gid)
        os.fsync(descriptor)
        os.fsync(root)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(root)


def control_unit(operation, execution_id, template="paws-agent"):
    return subprocess.run(
        ["/usr/bin/systemctl", *({"kill": ["kill", "--kill-whom=all", "--signal=SIGKILL"], "show": ["show", "--property=ControlGroup", "--value"]}.get(operation, [operation])), "--", f"{template}@{execution_id}.service"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if operation == "show" else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env={"PATH": "/usr/bin:/bin", "LANG": "C"},
        timeout=5 if operation in ("kill", "show") else 45,
        check=False,
    )


def stop_unit(execution_id):
    fence(execution_id)
    return stop_fixed_unit(execution_id, "paws-agent")


def stop_fixed_unit(execution_id, template, kill=True):
    if kill:
        try:
            control_unit("kill", execution_id, template)
        except subprocess.TimeoutExpired:
            pass
    if control_unit("stop", execution_id, template).returncode != 0:
        return False
    status = control_unit("show", execution_id, template)
    if status.returncode != 0 or len(status.stdout) > 4096:
        return False
    group = status.stdout.decode().strip()
    if not group:
        return True
    if not group.startswith("/") or any(part in (".", "..") for part in group.split("/")):
        return False
    try:
        directory = open_directory("/sys/fs/cgroup" + group)
    except FileNotFoundError:
        return True
    try:
        descriptor = os.open("cgroup.events", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            return b"populated 0" in os.read(descriptor, 1024).splitlines()
        finally:
            os.close(descriptor)
    finally:
        os.close(directory)


def read_request(connection, runner_uid):
    connection.settimeout(2)
    _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if uid not in (runner_uid, 0):
        raise PermissionError("Invalid caller")
    payload = bytearray()
    while b"\n" not in payload:
        chunk = connection.recv(1025 - len(payload))
        if not chunk:
            raise ValueError("Incomplete request")
        payload.extend(chunk)
        if len(payload) > 1024:
            raise ValueError("Request too large")
    if payload.count(b"\n") != 1 or not payload.endswith(b"\n"):
        raise ValueError("Invalid framing")
    request = json.loads(payload)
    if not isinstance(request, dict) or set(request) != {"operation", "executionId"} or request["operation"] not in ("start", "stop", "start-check", "stop-check", "start-check-child", "stop-check-child") or not isinstance(request["executionId"], str) or not EXECUTION_ID.fullmatch(request["executionId"]):
        raise ValueError("Invalid request")
    if uid != (0 if request["operation"] in ("start-check-child", "stop-check-child") else runner_uid):
        raise PermissionError("Invalid operation caller")
    return request


def check_broker():
    specification = importlib.util.spec_from_file_location("paws_check_broker", os.path.join(os.path.dirname(__file__), "check-broker.py"))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def handle(connection, runner_uid, agent_uid, agent_gid, results_gid, request=None):
    try:
        request = request or read_request(connection, runner_uid)
        if request["operation"] not in ("start", "stop"):
            response = check_broker().handle(sys.modules[__name__], request, runner_uid)
            connection.sendall(json.dumps(response).encode() + b"\n")
            return
        validate_unit()
        if request["operation"] == "start":
            validate_job(request["executionId"], runner_uid, agent_gid)
            if not admit_once(request["executionId"]):
                connection.sendall(b'{"ok":true,"alreadyAdmitted":true}\n')
                return
            prepare_results(request["executionId"], agent_uid, results_gid)
        if request["operation"] == "stop":
            success = stop_unit(request["executionId"])
        else:
            try:
                result = control_unit("start", request["executionId"])
            except subprocess.TimeoutExpired:
                stop_unit(request["executionId"])
                raise
            with lifecycle(request["executionId"]) as directory:
                success = result.returncode == 0 and not stopped(directory, request["executionId"])
        response = {"ok": success}
        if request["operation"] == "start":
            response["alreadyAdmitted"] = False
        connection.sendall(json.dumps(response).encode() + b"\n")
    except (OSError, ValueError, TypeError, RecursionError, subprocess.SubprocessError):
        try:
            connection.sendall(b'{"ok":false}\n')
        except OSError:
            pass
    finally:
        connection.close()


def main():
    if os.getuid() != 0 or os.environ.get("LISTEN_PID") != str(os.getpid()) or os.environ.get("LISTEN_FDS") != "1":
        raise RuntimeError("Root socket activation required")
    runner = pwd.getpwnam("paws-runner")
    agent = pwd.getpwnam("paws-agent")
    if runner.pw_uid == 0 or agent.pw_uid == 0 or runner.pw_uid == agent.pw_uid:
        raise RuntimeError("Separate service users required")
    listener = socket.socket(fileno=3)
    if listener.family != socket.AF_UNIX or listener.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM or listener.getsockname() != "/run/paws-runner-broker.sock":
        raise RuntimeError("Invalid activated socket")
    validate_unit()
    serve(listener, runner.pw_uid, agent.pw_uid, agent.pw_gid, grp.getgrnam("paws-results").gr_gid)


def serve(listener, runner_uid, agent_uid, agent_gid, results_gid):
    slots = {operation: threading.BoundedSemaphore(8) for operation in ("start", "stop", "start-check", "stop-check", "start-check-child", "stop-check-child")}
    def dispatch(connection, request, semaphore):
        try:
            handle(connection, runner_uid, agent_uid, agent_gid, results_gid, request)
        finally:
            semaphore.release()
    while True:
        connection, _ = listener.accept()
        try:
            request = read_request(connection, runner_uid)
            semaphore = slots[request["operation"]]
            if not semaphore.acquire(blocking=False):
                raise ValueError("Broker operation capacity reached")
            threading.Thread(target=dispatch, args=(connection, request, semaphore), daemon=True).start()
        except (OSError, ValueError, TypeError, RecursionError):
            try:
                connection.sendall(b'{"ok":false}\n')
            except OSError:
                pass
            connection.close()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] in ("guard-check-witness", "guard-check-child"):
        try:
            sys.exit(0 if check_broker().guard(sys.modules[__name__], sys.argv[2], sys.argv[1]) else 1)
        except (OSError, ValueError, StopIteration):
            sys.exit(1)
    elif len(sys.argv) == 3 and sys.argv[1] == "guard":
        try:
            sys.exit(0 if guard(sys.argv[2]) else 1)
        except (OSError, ValueError, StopIteration):
            sys.exit(1)
    elif len(sys.argv) == 1:
        main()
    else:
        sys.exit(1)
