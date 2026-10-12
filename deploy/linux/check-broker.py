import grp
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
import pathlib
import pwd
import stat
import subprocess
import uuid


RECEIPTS = "/var/lib/paws-check-broker"
CONTROL = "/var/lib/paws-check-control"
PRIVATE = "/var/lib/paws-check-metadata"
WORK = "/var/lib/paws-check-attempts"
SYSTEMD = "/run/systemd/system"


def witness_module():
    specification = importlib.util.spec_from_file_location("paws_check_witness", os.path.join(os.path.dirname(__file__), "check-witness.py"))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def read_root_file(common, parent, name, maximum=4096):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        common.validate_receipt(descriptor)
        content = os.read(descriptor, maximum + 1)
        if len(content) > maximum:
            raise ValueError("Check root file exceeds size limit")
        return content
    finally:
        os.close(descriptor)


def private_directory(common, path, gid=0, mode=0o700):
    descriptor = common.open_directory(path)
    info = os.fstat(descriptor)
    if info.st_uid != 0 or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:
        os.close(descriptor)
        raise ValueError("Unsafe check root directory")
    return descriptor


def write_root_file(parent, name, content):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.fsync(parent)


def validate_unit(name):
    descriptor = os.open("/etc/systemd/system/" + name + "@.service", os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("Unsafe check unit")
    finally:
        os.close(descriptor)


def active_execution(common, directory):
    try:
        value = read_root_file(common, directory, "active", 26).decode("ascii")
    except FileNotFoundError:
        return None
    if not common.EXECUTION_ID.fullmatch(value):
        raise ValueError("Invalid active check identity")
    return value


def reserve(common, execution_id):
    with common.lifecycle("active", RECEIPTS) as root:
        with common.lifecycle(execution_id, RECEIPTS) as receipt:
            if not common.mark_once(receipt, execution_id):
                return False
            active = active_execution(common, root)
            if active is not None:
                raise ValueError("Another check requires confirmed teardown")
            write_root_file(root, "active", execution_id.encode("ascii"))
            return True


def fence(common, execution_id, child=False):
    with common.lifecycle(execution_id, RECEIPTS) as root:
        common.mark_once(root, execution_id + (".child-stopped" if child else ".stopped"))
        common.mark_once(root, execution_id)


def clear_active(common, execution_id):
    with common.lifecycle("active", RECEIPTS) as root:
        if active_execution(common, root) == execution_id:
            os.unlink("active", dir_fd=root)
            os.fsync(root)


def stop_check(common, execution_id):
    fence(common, execution_id)
    def kill(template):
        try:
            common.control_unit("kill", execution_id, template)
        except subprocess.TimeoutExpired:
            pass
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(kill, ("paws-check", "paws-check-witness")))
        child = pool.submit(common.stop_fixed_unit, execution_id, "paws-check", False)
        witness = pool.submit(common.stop_fixed_unit, execution_id, "paws-check-witness", False)
        child_stopped, witness_stopped = child.result(), witness.result()
    if child_stopped and witness_stopped:
        remove_drop_in(common, execution_id)
        clear_active(common, execution_id)
        return True
    return False


def prepare_directory(common, parent, name, uid, gid, mode):
    os.mkdir(name, mode=0o700, dir_fd=parent)
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        os.fchmod(descriptor, mode)
        os.fchown(descriptor, uid, gid)
        os.fsync(descriptor)
        os.fsync(parent)
    finally:
        os.close(descriptor)


def prepare_attempt(common, job, check, metadata_gid):
    attempt_id = job["verificationAttemptId"]
    binding = json.dumps({"verificationAttemptId": attempt_id, "candidateSha": job["candidateSha"]}, sort_keys=True, separators=(",", ":")).encode()
    root = private_directory(common, PRIVATE, metadata_gid, 0o750)
    work = private_directory(common, WORK, check.pw_gid, 0o750)
    private = None
    workspace = None
    try:
        try:
            prepare_directory(common, root, attempt_id, 0, metadata_gid, 0o750)
        except FileExistsError:
            private = private_directory(common, PRIVATE + "/" + attempt_id, metadata_gid, 0o750)
            if read_root_file(common, private, "binding.json") != binding:
                raise ValueError("Check attempt candidate binding differs")
            workspace = private_directory(common, WORK + "/" + attempt_id, check.pw_gid, 0o750)
            return
        private = private_directory(common, PRIVATE + "/" + attempt_id, metadata_gid, 0o750)
        write_root_file(private, "binding.json", binding)
        prepare_directory(common, private, "git", check.pw_uid, metadata_gid, 0o770)
        prepare_directory(common, work, attempt_id, 0, check.pw_gid, 0o750)
        workspace = private_directory(common, WORK + "/" + attempt_id, check.pw_gid, 0o750)
        for name in ("workspace", "home", "tmp"):
            prepare_directory(common, workspace, name, check.pw_uid, check.pw_gid, 0o700)
    finally:
        for descriptor in (workspace, private, work, root):
            if descriptor is not None:
                os.close(descriptor)


def prepare_control(common, execution_id, job, digest):
    root = private_directory(common, CONTROL)
    parent = None
    try:
        prepare_directory(common, root, execution_id, 0, 0, 0o700)
        parent = private_directory(common, CONTROL + "/" + execution_id)
        identity = {"format": 1, "executionId": execution_id, "verificationAttemptId": job["verificationAttemptId"], "candidateSha": job["candidateSha"], "inputSha256": digest}
        write_root_file(parent, "identity.json", json.dumps(identity, sort_keys=True, separators=(",", ":")).encode())
    finally:
        if parent is not None:
            os.close(parent)
        os.close(root)


def drop_in_root(common):
    descriptor = common.open_directory(SYSTEMD)
    info = os.fstat(descriptor)
    if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
        os.close(descriptor)
        raise ValueError("Unsafe runtime unit directory")
    return descriptor


def publish_drop_in(common, execution_id, attempt_id):
    root = drop_in_root(common)
    stage = ".paws-check-" + execution_id + "." + uuid.uuid4().hex
    name = "paws-check@" + execution_id + ".service.d"
    parent = None
    try:
        with common.lifecycle(execution_id, RECEIPTS) as receipt:
            if common.stopped(receipt, execution_id):
                raise ValueError("Interrupted check cannot publish unit configuration")
            os.mkdir(stage, mode=0o700, dir_fd=root)
            parent = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
            check_gid = pwd.getpwnam("paws-check").pw_gid
            write_root_file(parent, "attempt.conf", ("[Service]\nTemporaryFileSystem=/var/lib/paws-check-attempts:ro,mode=0750,gid=" + str(check_gid) + "\nBindPaths=/var/lib/paws-check-attempts/" + attempt_id + "\n").encode("ascii"))
            descriptor = os.open("attempt.conf", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                os.fchmod(descriptor, 0o644)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            os.fchmod(parent, 0o755)
            os.fsync(parent)
            try:
                os.stat(name, dir_fd=root, follow_symlinks=False)
                raise ValueError("Check instance configuration already exists")
            except FileNotFoundError:
                pass
            os.rename(stage, name, src_dir_fd=root, dst_dir_fd=root)
            stage = None
            os.fsync(root)
    finally:
        if parent is not None:
            os.close(parent)
        if stage is not None:
            try:
                os.unlink(stage + "/attempt.conf", dir_fd=root)
            except FileNotFoundError:
                pass
            try:
                os.rmdir(stage, dir_fd=root)
            except FileNotFoundError:
                pass
        os.close(root)
    with common.lifecycle("manager", RECEIPTS):
        subprocess.run(["/usr/bin/systemctl", "daemon-reload"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin", "LANG": "C"}, timeout=5, check=True)


def remove_drop_in(common, execution_id):
    root = drop_in_root(common)
    parent = None
    try:
        with common.lifecycle(execution_id, RECEIPTS):
            name = "paws-check@" + execution_id + ".service.d"
            try:
                parent = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
            except FileNotFoundError:
                return
            info = os.fstat(parent)
            if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o755 or os.listdir(parent) != ["attempt.conf"]:
                raise ValueError("Unsafe check instance configuration")
            descriptor = os.open("attempt.conf", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                info = os.fstat(descriptor)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o644:
                    raise ValueError("Unsafe check instance mount configuration")
            finally:
                os.close(descriptor)
            os.unlink("attempt.conf", dir_fd=parent)
            os.fsync(parent)
            os.rmdir(name, dir_fd=root)
            os.fsync(root)
    finally:
        if parent is not None:
            os.close(parent)
        os.close(root)


def guard(common, execution_id, kind):
    capabilities = next(line.split()[1] for line in pathlib.Path("/proc/self/status").read_text().splitlines() if line.startswith("CapEff:"))
    expected = 192 if kind == "guard-check-witness" else 0
    if os.getuid() != 0 or int(capabilities, 16) != expected or not common.EXECUTION_ID.fullmatch(execution_id):
        return False
    with common.lifecycle(execution_id, RECEIPTS) as root:
        read_root_file(common, root, execution_id, 0)
        if common.stopped(root, execution_id):
            return False
        if kind == "guard-check-child":
            read_root_file(common, root, execution_id + ".child", 0)
            try:
                read_root_file(common, root, execution_id + ".child-stopped", 0)
                return False
            except FileNotFoundError:
                pass
        return common.mark_once(root, execution_id + (".launched" if kind == "guard-check-witness" else ".child-launched"))


def handle(common, request, runner_uid):
    execution_id, operation = request["executionId"], request["operation"]
    validate_unit("paws-check")
    validate_unit("paws-check-witness")
    if operation == "stop-check":
        return {"ok": stop_check(common, execution_id)}
    if operation == "stop-check-child":
        fence(common, execution_id, True)
        return {"ok": common.stop_fixed_unit(execution_id, "paws-check")}
    if operation == "start-check-child":
        with common.lifecycle(execution_id, RECEIPTS) as root:
            read_root_file(common, root, execution_id, 0)
            if common.stopped(root, execution_id):
                return {"ok": False}
            if not common.mark_once(root, execution_id + ".child"):
                return {"ok": True, "alreadyAdmitted": True}
        result = common.control_unit("start", execution_id, "paws-check")
        with common.lifecycle(execution_id, RECEIPTS) as root:
            return {"ok": result.returncode == 0 and not common.stopped(root, execution_id), "alreadyAdmitted": False}
    job, digest = witness_module().read_input(execution_id, runner_uid, grp.getgrnam("paws-check-input").gr_gid)
    if not reserve(common, execution_id):
        return {"ok": True, "alreadyAdmitted": True}
    prepare_attempt(common, job, pwd.getpwnam("paws-check"), grp.getgrnam("paws-check-metadata").gr_gid)
    prepare_control(common, execution_id, job, digest)
    publish_drop_in(common, execution_id, job["verificationAttemptId"])
    try:
        result = common.control_unit("start", execution_id, "paws-check-witness")
    except subprocess.TimeoutExpired:
        stop_check(common, execution_id)
        raise
    with common.lifecycle(execution_id, RECEIPTS) as root:
        return {"ok": result.returncode == 0 and not common.stopped(root, execution_id), "alreadyAdmitted": False}
