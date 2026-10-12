import hashlib
import base64
import json
import os
import pwd
import grp
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import tempfile


IDENTIFIER = re.compile(r"[0-7][0-9A-HJKMNP-TV-Z]{25}\Z")
SHA = re.compile(r"[a-f0-9]{40}\Z")
PRIVATE = "/var/lib/paws-check-metadata"
WORK = "/var/lib/paws-check-attempts"
INPUT = "/var/lib/paws-check-input/attempts"
OPTIONS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "submodule.recurse=false", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=always"]
ENVIRONMENT = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/var/empty", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"}


def directory(path):
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split("/"):
            if not part:
                continue
            if part in (".", ".."):
                raise ValueError("Invalid metadata path")
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def validate_directory(path, uid, gid, mode):
    descriptor = directory(path)
    try:
        info = os.fstat(descriptor)
        if info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:
            raise ValueError("Unsafe metadata directory")
    finally:
        os.close(descriptor)


def read_file(parent, name, maximum, uid=None, gid=None, mode=None):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum or (uid is not None and info.st_uid != uid) or (gid is not None and info.st_gid != gid) or (mode is not None and stat.S_IMODE(info.st_mode) != mode):
            raise ValueError("Unsafe metadata file")
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            content = stream.read(maximum + 1)
        if len(content) > maximum:
            raise ValueError("Metadata file exceeds size limit")
        return content
    finally:
        os.close(descriptor)


def git(arguments, allowed=(0,), environment=None, input_file=None, output_limit=65536):
    process = subprocess.Popen(["/usr/bin/git", *OPTIONS, *arguments], stdin=input_file if input_file is not None else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment or ENVIRONMENT, start_new_session=True, umask=0o007)
    streams = selectors.DefaultSelector()
    streams.register(process.stdout, selectors.EVENT_READ, 0)
    streams.register(process.stderr, selectors.EVENT_READ, 1)
    output = [bytearray(), bytearray()]
    deadline = time.monotonic() + 60
    try:
        while streams.get_map():
            if time.monotonic() >= deadline:
                raise TimeoutError("Metadata Git timed out")
            for key, _ in streams.select(0.1):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    streams.unregister(key.fileobj)
                else:
                    output[key.data].extend(chunk)
                    if len(output[key.data]) > (output_limit if key.data == 0 else 65536):
                        raise ValueError("Metadata Git output exceeds size limit")
        status = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        if status not in allowed:
            raise ValueError("Metadata Git failed")
        return status, bytes(output[0])
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        streams.close()
        process.stdout.close()
        process.stderr.close()


def attempt_input(attempt, runner_uid, input_gid):
    descriptor = directory(INPUT + "/" + attempt)
    try:
        info = os.fstat(descriptor)
        if info.st_uid != runner_uid or info.st_gid != input_gid or stat.S_IMODE(info.st_mode) != 0o750:
            raise ValueError("Unsafe attempt input directory")
        identity = json.loads(read_file(descriptor, "attempt.json", 4096, runner_uid, input_gid, 0o640))
        if not isinstance(identity, dict) or set(identity) != {"format", "verificationAttemptId", "candidateSha", "bundleSha256"} or identity["format"] != 1 or identity["verificationAttemptId"] != attempt or not isinstance(identity["candidateSha"], str) or not SHA.fullmatch(identity["candidateSha"]) or not isinstance(identity["bundleSha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", identity["bundleSha256"]):
            raise ValueError("Invalid attempt identity")
        copy_bundle(descriptor, identity, runner_uid, input_gid)
        return identity
    finally:
        os.close(descriptor)


def copy_bundle(parent, identity, runner_uid, input_gid, destination=None):
    bundle = os.open("repository.bundle", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    snapshot = None
    try:
        info = os.fstat(bundle)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != runner_uid or info.st_gid != input_gid or stat.S_IMODE(info.st_mode) != 0o640 or info.st_nlink != 1 or not 0 < info.st_size <= 536870912:
            raise ValueError("Unsafe candidate bundle")
        if destination is not None:
            snapshot = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
            os.fchmod(snapshot, 0o640)
        digest = hashlib.sha256()
        count = 0
        while chunk := os.read(bundle, 1048576):
            count += len(chunk)
            if count > 536870912:
                raise ValueError("Candidate bundle exceeds size limit")
            digest.update(chunk)
            if snapshot is not None:
                pending = memoryview(chunk)
                while pending:
                    written = os.write(snapshot, pending)
                    if written <= 0:
                        raise OSError("Candidate bundle snapshot write failed")
                    pending = pending[written:]
        if count == 0 or digest.hexdigest() != identity["bundleSha256"]:
            raise ValueError("Candidate bundle digest mismatch")
        if snapshot is not None:
            os.fsync(snapshot)
    finally:
        if snapshot is not None:
            os.close(snapshot)
        os.close(bundle)


def actual_head(workspace, check_uid):
    parent = directory(workspace + "/.git")
    try:
        info = os.fstat(parent)
        if info.st_uid != check_uid:
            raise ValueError("Unsafe repository metadata")
        head = read_file(parent, "HEAD", 4096, check_uid).decode().strip()
        if SHA.fullmatch(head):
            return head
        if not head.startswith("ref: "):
            raise ValueError("Invalid repository HEAD")
        reference = head[5:]
        if not re.fullmatch(r"refs/[A-Za-z0-9_./-]{1,512}", reference) or any(part in (".", "..", "") for part in reference.split("/")):
            raise ValueError("Invalid repository reference")
        current = os.dup(parent)
        try:
            parts = reference.split("/")
            for part in parts[:-1]:
                following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                os.close(current)
                current = following
            value = read_file(current, parts[-1], 4096, check_uid).decode().strip()
            if not SHA.fullmatch(value):
                raise ValueError("Invalid repository reference value")
            return value
        except FileNotFoundError:
            packed = read_file(parent, "packed-refs", 4194304, check_uid).decode()
            values = [line.split(" ") for line in packed.splitlines() if line.endswith(" " + reference)]
            if len(values) != 1 or len(values[0]) != 2 or not SHA.fullmatch(values[0][0]):
                raise ValueError("Invalid packed repository reference")
            return values[0][0]
        finally:
            os.close(current)
    finally:
        os.close(parent)


def initialize(identity, private, workspace, runner_uid, input_gid):
    if os.listdir(private) or os.listdir(workspace):
        raise ValueError("Attempt workspace was already initialized")
    bundle = private + "/repository.bundle"
    source = directory(INPUT + "/" + identity["verificationAttemptId"])
    try:
        copy_bundle(source, identity, runner_uid, input_gid, bundle)
    finally:
        os.close(source)
    candidate = identity["candidateSha"]
    git(["init", "--bare", private])
    git(["--git-dir=" + private, "fetch", "--no-tags", "--no-recurse-submodules", bundle, candidate])
    git(["--git-dir=" + private, "update-ref", "--no-deref", "HEAD", candidate])
    git(["--git-dir=" + private, "read-tree", candidate])
    git(["-C", workspace, "init"])
    git(["-C", workspace, "fetch", "--no-tags", "--no-recurse-submodules", bundle, candidate])
    git(["-C", workspace, "checkout", "--force", "--detach", candidate])
    descriptor = os.open(private + "/baseline.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    os.fchmod(descriptor, 0o640)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(identity, stream, sort_keys=True, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())


def gitlinks(records):
    links = {}
    for record in records.split(b"\0"):
        if not record:
            continue
        metadata, path = record.split(b"\t", 1)
        fields = metadata.split(b" ")
        if fields[0] == b"160000":
            if len(fields) != 3 or path in links:
                raise ValueError("Invalid submodule metadata")
            links[path] = fields[1] if fields[2] == b"0" else fields[2]
    return links


def reject_populated_submodules(workspace, links):
    for path in links:
        parts = path.split(b"/")
        if any(part in (b"", b".", b"..") for part in parts):
            raise ValueError("Invalid submodule path")
        parent = directory(workspace)
        try:
            for part in parts:
                try:
                    following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                except FileNotFoundError:
                    break
                os.close(parent)
                parent = following
            else:
                if os.listdir(parent):
                    raise ValueError("Populated submodules are refused")
        finally:
            os.close(parent)


def inspect(identity, private, workspace, check_uid, metadata_gid):
    parent = directory(private)
    try:
        baseline = json.loads(read_file(parent, "baseline.json", 4096, check_uid, metadata_gid, 0o640))
        if baseline != identity:
            raise ValueError("Attempt baseline identity mismatch")
    finally:
        os.close(parent)
    head_moved = True
    status = None
    try:
        head_moved = actual_head(workspace, check_uid) != identity["candidateSha"]
        arguments = ["--git-dir=" + private, "--work-tree=" + workspace]
        metadata = directory(workspace + "/.git")
        try:
            index = read_file(metadata, "index", 67108864, check_uid)
        finally:
            os.close(metadata)
        snapshot = os.open(private + "/observed.index", os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o640)
        os.fchmod(snapshot, 0o640)
        with os.fdopen(snapshot, "wb") as stream:
            stream.write(index)
        index_environment = ENVIRONMENT.copy()
        index_environment["GIT_INDEX_FILE"] = private + "/observed.index"
        baseline_links = gitlinks(git(["--git-dir=" + private, "ls-tree", "-r", "-z", identity["candidateSha"]], output_limit=67108864)[1])
        entries = git([*arguments, "ls-files", "--stage", "-z"], environment=index_environment, output_limit=67108864)[1]
        observed_links = gitlinks(entries)
        if baseline_links != observed_links:
            raise ValueError("Submodule index differs from the candidate")
        reject_populated_submodules(workspace, baseline_links)
        os.unlink(private + "/observed.index")
        with tempfile.TemporaryFile(dir=private) as input_file:
            input_file.write(entries)
            input_file.seek(0)
            git([*arguments, "update-index", "-z", "--index-info"], environment=index_environment, input_file=input_file)
        content = git([*arguments, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"], environment=index_environment)[1]
        reject_populated_submodules(workspace, baseline_links)
        status = base64.b64encode(content).decode("ascii")
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        status = None
    return {"status": status, "headMoved": head_moved}


def main():
    check = pwd.getpwnam("paws-check")
    runner = pwd.getpwnam("paws-runner")
    input_gid = grp.getgrnam("paws-check-input").gr_gid
    metadata_gid = grp.getgrnam("paws-check-metadata").gr_gid
    capabilities = next(line.split()[1] for line in open("/proc/self/status") if line.startswith("CapEff:"))
    if check.pw_uid == 0 or os.getuid() != check.pw_uid or os.getgid() != metadata_gid or set(os.getgroups()) != {check.pw_gid, input_gid} or int(capabilities, 16) != 0 or len(sys.argv) != 4 or sys.argv[1] not in ("init", "inspect") or not IDENTIFIER.fullmatch(sys.argv[2]) or not SHA.fullmatch(sys.argv[3]):
        raise ValueError("Fixed trusted metadata identity required")
    attempt = sys.argv[2]
    validate_directory(PRIVATE, 0, metadata_gid, 0o750)
    validate_directory(PRIVATE + "/" + attempt, 0, metadata_gid, 0o750)
    private = PRIVATE + "/" + attempt + "/git"
    validate_directory(private, check.pw_uid, metadata_gid, 0o770)
    validate_directory(WORK, 0, check.pw_gid, 0o750)
    validate_directory(WORK + "/" + attempt, 0, check.pw_gid, 0o750)
    workspace = WORK + "/" + attempt + "/workspace"
    validate_directory(workspace, check.pw_uid, check.pw_gid, 0o700)
    identity = attempt_input(attempt, runner.pw_uid, input_gid)
    if identity["candidateSha"] != sys.argv[3]:
        raise ValueError("Attempt differs from root-admitted candidate")
    if sys.argv[1] == "init":
        initialize(identity, private, workspace, runner.pw_uid, input_gid)
    print(json.dumps(inspect(identity, private, workspace, check.pw_uid, metadata_gid), separators=(",", ":")))


if __name__ == "__main__":
    main()
