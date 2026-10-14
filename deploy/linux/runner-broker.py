import json
import hashlib
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
import time


EXECUTION_ID = re.compile(r"[0-7][0-9A-HJKMNP-TV-Z]{25}\Z")
SPOOL = "/var/lib/paws-runner-spool"
UNIT = "/etc/systemd/system/paws-agent@.service"
RECEIPTS = "/var/lib/paws-runner-broker"
RESULTS = "/var/lib/paws-agent-results"
TASK_WORK = "/var/lib/paws-agent-tasks"
MEMBER_HOMES = "/var/lib/paws-runner-members"


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
        if not isinstance(job, dict) or set(job) != {"executionId", "command"} or job["executionId"] != execution_id or not isinstance(job["command"], dict) or job["command"].get("type") not in ("run", "review", "probe", "login_check", "login", "helper", "task"):
            raise ValueError("Invalid job")
        if job["command"]["type"] in ("run", "review"):
            descriptor = os.open("repository.bundle", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != runner_uid or info.st_gid != agent_gid or stat.S_IMODE(info.st_mode) != 0o640 or not 0 < info.st_size <= 536870912:
                raise ValueError("Unsafe repository bundle")
        if job["command"]["type"] == "task" and "repository" in job["command"]:
            snapshot = os.open("repository", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            try:
                validate_directory(snapshot, runner_uid, agent_gid)
            finally:
                os.close(snapshot)
        return job
    finally:
        for opened in (descriptor, directory, root):
            if opened is not None:
                os.close(opened)


def validate_unit():
    descriptor = os.open(UNIT, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 65536:
            raise ValueError("Unsafe worker unit")
        commands = [line[len("ExecStart="):] for line in os.read(descriptor, 65537).decode().splitlines() if line.startswith("ExecStart=")]
        if len(commands) != 1 or not commands[0].startswith("/"):
            raise ValueError("Invalid worker entry point")
        return commands[0]
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


def expiry_receipt(directory, execution_id):
    descriptor = os.open(execution_id + ".expiry", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        validate_receipt(descriptor)
        if os.fstat(descriptor).st_size > 256:
            raise ValueError("Expiry receipt exceeds size limit")
        receipt = json.loads(os.read(descriptor, 257))
        if not isinstance(receipt, dict) or set(receipt) != {"expiresAt", "commandDigest"} or type(receipt["expiresAt"]) is not int or not 0 < receipt["expiresAt"] <= 9007199254740991 or not isinstance(receipt["commandDigest"], str) or not re.fullmatch(r"[0-9a-f]{64}", receipt["commandDigest"]):
            raise ValueError("Invalid expiry receipt")
        return receipt
    finally:
        os.close(descriptor)


def admit_once(execution_id, command):
    expires_at = command.get("expiresAt")
    if type(expires_at) is not int or not 0 < expires_at <= 9007199254740991:
        raise ValueError("Invalid command expiry")
    digest = hashlib.sha256(json.dumps(command, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    with lifecycle(execution_id) as directory:
        if stopped(directory, execution_id):
            return False
        try:
            descriptor = os.open(execution_id, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            descriptor = None
        if descriptor is not None:
            try:
                validate_receipt(descriptor)
                if expiry_receipt(directory, execution_id)["commandDigest"] != digest:
                    raise ValueError("Command changed after admission")
                return False
            finally:
                os.close(descriptor)
        if expires_at <= time.time_ns() // 1000000:
            raise ValueError("Command expired")
        expected = {"expiresAt": expires_at, "commandDigest": digest}
        try:
            existing = expiry_receipt(directory, execution_id)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if existing != expected:
                raise ValueError("Command changed before admission")
        else:
            pending = execution_id + ".expiry-" + os.urandom(16).hex()
            descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(json.dumps(expected).encode())
                    stream.flush()
                    os.fsync(stream.fileno())
                os.rename(pending, execution_id + ".expiry", src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
            finally:
                try:
                    os.unlink(pending, dir_fd=directory)
                except FileNotFoundError:
                    pass
        return mark_once(directory, execution_id)


def arm_deadline(directory, execution_id):
    expiry = expiry_receipt(directory, execution_id)["expiresAt"]
    if expiry <= time.time_ns() // 1000000:
        mark_once(directory, execution_id + ".stopped")
        return False
    timer = "paws-agent-expiry-" + execution_id + ".timer"
    active = subprocess.run(["/usr/bin/systemctl", "is-active", "--quiet", "--", timer],
                            check=False, timeout=5, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if active.returncode != 0:
        subprocess.run(["/usr/bin/systemd-run", "--unit=paws-agent-expiry-" + execution_id,
                        "--on-calendar=" + time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(expiry // 1000)) + "." + str(expiry % 1000).zfill(3) + " UTC",
                        "--timer-property=AccuracySec=1ms", "--timer-property=Persistent=yes",
                        "--timer-property=RemainAfterElapse=no", "--collect", "--property=Type=exec",
                        "--property=CapabilityBoundingSet=", "--property=NoNewPrivileges=yes",
                        "--property=ProtectSystem=strict", "--property=ReadWritePaths=" + RECEIPTS,
                        "/usr/bin/python3", "-I", "-B", "/opt/paws-runner/current/deploy/linux/runner-broker.py",
                        "expire", execution_id], check=True, timeout=4, stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if expiry <= time.time_ns() // 1000000:
        mark_once(directory, execution_id + ".stopped")
        return False
    return True


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
        if not arm_deadline(directory, execution_id):
            return False
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


def prepare_task_work(execution_id, agent_uid, agent_gid, repository):
    root = open_directory(TASK_WORK)
    directory = None
    try:
        info = os.fstat(root)
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
            raise ValueError("Unsafe task work root")
        os.mkdir(execution_id, mode=0o700, dir_fd=root)
        directory = os.open(execution_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        if repository:
            os.mkdir("repository", mode=0o555, dir_fd=directory)
        os.fchmod(directory, 0o700)
        os.fchown(directory, agent_uid, agent_gid)
        os.fsync(directory)
        os.fsync(root)
    finally:
        if directory is not None:
            os.close(directory)
        os.close(root)


def prepare_member(execution_id, command, agent_uid, agent_gid, runner_uid, results_gid):
    member = command.get("memberId")
    if member is None:
        return
    workspace = command.get("workspaceId")
    if not all(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value) for value in (member, workspace)):
        raise ValueError("Invalid member identity")
    identity = hashlib.sha256(json.dumps([workspace, member], separators=(",", ":")).encode()).hexdigest()
    root = open_directory(MEMBER_HOMES)
    directory = None
    try:
        info = os.fstat(root)
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("Unsafe member homes")
        try:
            os.mkdir(identity, mode=0o700, dir_fd=root)
            created = True
        except FileExistsError:
            created = False
        directory = os.open(identity, (os.O_RDONLY if created else os.O_PATH) | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        info = os.fstat(directory)
        if created and info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o700:
            os.fchown(directory, agent_uid, agent_gid)
        elif info.st_uid != agent_uid or info.st_gid != agent_gid or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("Unsafe member home")
        if created:
            os.fsync(directory)
            os.fsync(root)
    finally:
        if directory is not None:
            os.close(directory)
        os.close(root)
    root = open_directory("/run/systemd/system")
    directory = None
    descriptor = None
    try:
        info = os.fstat(root)
        if info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022:
            raise ValueError("Unsafe runtime units")
        name = "paws-agent@" + execution_id + ".service.d"
        os.mkdir(name, mode=0o755, dir_fd=root)
        directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        descriptor = os.open("member.conf", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=directory)
        content = "\n".join([
            "[Service]", "PrivateUsers=yes", "ProtectKernelTunables=no", "Group=paws-results", "SupplementaryGroups=paws-agent", "StateDirectory=",
            "CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SETPCAP", "AmbientCapabilities=CAP_SYS_ADMIN CAP_SETPCAP",
            "ExecStart=", "ExecStart=/usr/bin/unshare --pid --fork --kill-child=KILL --mount-proc /usr/bin/python3 -I -B " + os.path.abspath(__file__) + " confine " + validate_unit(),
            "ExecCondition=", "ExecCondition=+/usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs /usr/bin/python3 -I -B /opt/paws-runner/current/deploy/linux/runner-broker.py guard %i",
            "ReadOnlyPaths=", "ReadWritePaths=", "BindReadOnlyPaths=",
            "BindPaths=" + MEMBER_HOMES + "/" + identity + ":/var/lib/paws-agent",
            "ReadWritePaths=" + RECEIPTS,
            "TemporaryFileSystem=" + SPOOL + ":ro,mode=2750,uid=" + str(runner_uid) + ",gid=" + str(agent_gid),
            "TemporaryFileSystem=" + RESULTS + ":ro,mode=0750,uid=0,gid=" + str(results_gid),
            "TemporaryFileSystem=" + TASK_WORK + ":ro,mode=0755,uid=0,gid=0",
            "BindPaths=-" + TASK_WORK + "/" + execution_id,
            "BindReadOnlyPaths=-" + SPOOL + "/" + execution_id + "/repository:" + TASK_WORK + "/" + execution_id + "/repository",
            "BindReadOnlyPaths=" + SPOOL + "/" + execution_id,
            "BindPaths=" + RESULTS + "/" + execution_id,
            "InaccessiblePaths=" + MEMBER_HOMES,
            "", ])
        os.write(descriptor, content.encode())
        os.fsync(descriptor)
        os.fsync(directory)
        os.fsync(root)
    finally:
        for opened in (descriptor, directory, root):
            if opened is not None:
                os.close(opened)
    subprocess.run(["/usr/bin/systemctl", "daemon-reload"], check=True, timeout=30, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


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
            job = validate_job(request["executionId"], runner_uid, agent_gid)
            if not admit_once(request["executionId"], job["command"]):
                connection.sendall(b'{"ok":true,"alreadyAdmitted":true}\n')
                return
            prepare_results(request["executionId"], agent_uid, results_gid)
            prepare_member(request["executionId"], job["command"], agent_uid, agent_gid, runner_uid, results_gid)
            if job["command"]["type"] == "task":
                prepare_task_work(request["executionId"], agent_uid, results_gid if job["command"].get("memberId") else agent_gid, "repository" in job["command"])
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
    if len(sys.argv) > 2 and sys.argv[1] == "confine":
        if os.getpid() != 1:
            raise RuntimeError("Private PID namespace required")
        subprocess.run(["/usr/bin/mount", "-o", "remount,ro,nosuid,nodev,noexec", "/proc"], check=True)
        os.execv("/usr/bin/setpriv", ["/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "/usr/bin/python3", "-I", "-B", os.path.abspath(__file__), "member-home", *sys.argv[2:]])
    elif len(sys.argv) > 2 and sys.argv[1] == "member-home":
        if os.getpid() != 1:
            raise RuntimeError("Private PID namespace required")
        for name in (".codex", ".claude"):
            path = "/var/lib/paws-agent/" + name
            try:
                os.mkdir(path, 0o700)
            except FileExistsError:
                pass
            directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                if os.fstat(directory).st_uid != os.getuid():
                    raise ValueError("Unsafe provider home")
                os.fchmod(directory, 0o700)
            finally:
                os.close(directory)
        os.execv(sys.argv[2], sys.argv[2:])
    elif len(sys.argv) == 3 and sys.argv[1] in ("guard-check-witness", "guard-check-child"):
        try:
            sys.exit(0 if check_broker().guard(sys.modules[__name__], sys.argv[2], sys.argv[1]) else 1)
        except (OSError, ValueError, StopIteration):
            sys.exit(1)
    elif len(sys.argv) == 3 and sys.argv[1] == "guard":
        try:
            sys.exit(0 if guard(sys.argv[2]) else 1)
        except (OSError, ValueError, StopIteration, subprocess.SubprocessError):
            sys.exit(255)
    elif len(sys.argv) == 3 and sys.argv[1] == "expire":
        try:
            sys.exit(0 if os.getuid() == 0 and EXECUTION_ID.fullmatch(sys.argv[2]) and stop_unit(sys.argv[2]) else 1)
        except (OSError, ValueError, subprocess.SubprocessError):
            sys.exit(1)
    elif len(sys.argv) == 1:
        main()
    else:
        sys.exit(1)
