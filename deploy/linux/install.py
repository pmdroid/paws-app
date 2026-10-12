import argparse
import fcntl
import importlib.util
import json
import os
import pathlib
import pwd
import grp
import shutil
import stat
import tempfile


spec = importlib.util.spec_from_file_location("paws_release", pathlib.Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
BASE = pathlib.Path("/opt/paws-runner")
STATE = pathlib.Path("/var/lib/paws-runner-install")


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def root_directory(path, mode=0o755):
    if not path.is_absolute():
        raise ValueError("Installation path must be absolute")
    current = pathlib.Path("/")
    for part in path.parts[1:]:
        current /= part
        try:
            current.mkdir(mode=mode if current == path else 0o755)
            current.chmod(mode if current == path else 0o755)
            sync_directory(current.parent)
        except FileExistsError:
            pass
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("Unsafe root installation directory")
    path.chmod(mode)
    sync_directory(path)


def write_atomic(path, content, mode):
    root_directory(path.parent, 0o700 if path.parent == STATE else 0o755)
    descriptor, temporary = tempfile.mkstemp(prefix=".paws-", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        pathlib.Path(temporary).unlink(missing_ok=True)


def validate_identity_separation():
    accounts = {}
    groups = {}
    for name in ("paws-runner", "paws-agent", "paws-check"):
        try:
            accounts[name] = pwd.getpwnam(name)
        except KeyError:
            pass
    for name in ("paws-runner", "paws-agent", "paws-check", "paws-results", "paws-check-input", "paws-check-metadata"):
        try:
            groups[name] = grp.getgrnam(name).gr_gid
        except KeyError:
            pass
    identifiers = [account.pw_uid for account in accounts.values()]
    if any(identifier <= 0 for identifier in identifiers) or len(set(identifiers)) != len(identifiers) or any(identifier <= 0 for identifier in groups.values()) or len(set(groups.values())) != len(groups):
        raise ValueError("Runner service identities must be distinct")
    private_groups = {groups[name] for name in ("paws-runner", "paws-check-input") if name in groups}
    allowed_names = {"paws-runner": ("paws-runner", "paws-agent", "paws-results", "paws-check-input"), "paws-agent": ("paws-agent", "paws-results"), "paws-check": ("paws-check",)}
    for name, account in accounts.items():
        membership = set(os.getgrouplist(name, account.pw_gid))
        if groups.get("paws-check-metadata") in membership:
            raise ValueError("Service identity belongs to the trusted metadata group")
        if name != "paws-runner" and private_groups & membership:
            raise ValueError("Untrusted service identity belongs to a private runner group")
        allowed = {groups[group] for group in allowed_names[name] if group in groups}
        if not membership <= allowed:
            raise ValueError("Runner service identity has an unrelated supplemental group")


def prerequisites():
    if os.getuid() != 0:
        raise ValueError("Installation requires root")
    for path in ("/usr/bin/node", "/usr/bin/git", "/usr/bin/openssl", "/usr/bin/python3", "/usr/bin/flock", "/usr/bin/systemctl", "/usr/bin/systemd-sysusers", "/usr/bin/systemd-tmpfiles"):
        resolved = pathlib.Path(path).resolve(strict=True)
        info = resolved.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or not info.st_mode & 0o001:
            raise ValueError("Unsafe or missing installation prerequisite")
        for parent in {pathlib.Path(path).parent, *pathlib.Path(path).parents, resolved.parent, *resolved.parents}:
            directory = parent.stat()
            if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o022 or not directory.st_mode & 0o001:
                raise ValueError("Unsafe or inaccessible prerequisite directory")
    node = release.command(["/usr/bin/node", "--version"]).decode().strip()
    if not node.startswith("v") or int(node[1:].split(".")[0]) < 22:
        raise ValueError("Node 22 or later is required at /usr/bin/node")
    if not release.command(["/usr/bin/openssl", "version"]).startswith(b"OpenSSL 3."):
        raise ValueError("OpenSSL 3 is required")
    release.command(["/usr/bin/git", "--version"])
    release.command(["/usr/bin/python3", "--version"])
    if not release.command(["/usr/bin/flock", "--version"]).startswith(b"flock from util-linux "):
        raise ValueError("util-linux flock is required at /usr/bin/flock")
    release.command(["/usr/bin/systemctl", "--version"])
    validate_identity_separation()


def admitted_release(manifest, fingerprint):
    record = STATE / "release.json"
    accepted = {"version": manifest["version"], "artifactSha256": manifest["artifactSha256"], "releaseKeyFingerprint": fingerprint}
    try:
        previous = json.loads(release.read_regular(record, 65536))
    except FileNotFoundError:
        return accepted
    if not isinstance(previous, dict) or set(previous) != set(accepted) | {"status"} or previous["status"] not in ("pending", "installed") or not release.SEMVER.fullmatch(previous["version"]):
        raise ValueError("Invalid installed release state")
    info = record.lstat()
    if info.st_uid != 0 or info.st_mode & 0o7777 != 0o600:
        raise ValueError("Unsafe installed release state")
    if previous["releaseKeyFingerprint"] != fingerprint:
        raise ValueError("Release trust key does not match installed trust")
    incoming = tuple(map(int, manifest["version"].split(".")))
    installed = tuple(map(int, previous["version"].split(".")))
    recovering = previous["status"] == "pending" and all(previous[key] == value for key, value in accepted.items())
    if previous["status"] == "pending" and not recovering:
        raise ValueError("Pending release must recover its exact artifact")
    if incoming <= installed and not recovering:
        raise ValueError("Release version must advance the installed version")
    return accepted


def refuse_active_executions():
    active = release.command(["/usr/bin/systemctl", "list-units", "--all", "--state=active,activating,deactivating", "--no-legend", "--no-pager", "--plain", "paws-agent@*.service", "paws-check@*.service", "paws-check-witness@*.service"])
    if active.strip():
        raise ValueError("Active agent executions must stop before installation")


def stop_for_install():
    refuse_active_executions()
    units = ["paws-runner.service", "paws-runner-broker.socket", "paws-runner-broker.service"]
    existing = release.command(["/usr/bin/systemctl", "list-unit-files", "--no-legend", "--no-pager", *units]).decode()
    present = [unit for unit in units if any(line.split()[0] == unit for line in existing.splitlines() if line.split())]
    if present:
        release.command(["/usr/bin/systemctl", "stop", "--", *present])
    refuse_active_executions()

def extract_verified(artifact, destination):
    members = release.inspect_archive(artifact)
    with artifact.open("rb") as incoming:
        for name, member in members.items():
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with target.open("xb") as outgoing:
                incoming.seek(member.offset_data)
                remaining = member.size
                while remaining:
                    chunk = incoming.read(min(1_048_576, remaining))
                    if not chunk:
                        raise ValueError("Truncated verified artifact")
                    outgoing.write(chunk)
                    remaining -= len(chunk)
                outgoing.flush()
                mode = member.mode
                if member.name == "bin/bun":
                    mode = 0o755
                elif member.name.startswith("deploy/linux/"):
                    mode = 0o644
                os.fchmod(outgoing.fileno(), mode)
                os.fsync(outgoing.fileno())
    for current, _, _ in os.walk(destination, topdown=False):
        os.chmod(current, 0o755)
        sync_directory(current)


def verify_selected_release(destination, unpacked):
    expected = {path.relative_to(unpacked / "app"): path for path in (unpacked / "app").rglob("*") if path.is_file()}
    expected.update({pathlib.Path("deploy/linux") / name: unpacked / "deploy/linux" / name for name in release.ASSETS})
    expected[pathlib.Path("bin/bun")] = unpacked / "bin/bun"
    seen = set()
    directories = {pathlib.Path(".")}
    for path in expected:
        directories.update(path.parents)
    for current, children, files in os.walk(destination, followlinks=False):
        parent = pathlib.Path(current)
        info = parent.lstat()
        if parent.relative_to(destination) not in directories or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
            raise ValueError("Selected pending release directory differs from its artifact")
        for name in children:
            if (parent / name).is_symlink():
                raise ValueError("Selected pending release contains a directory link")
        for name in files:
            path = parent / name
            relative = path.relative_to(destination)
            source = expected.get(relative)
            info = path.lstat()
            if source is None or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != stat.S_IMODE(source.stat().st_mode) or release.read_regular(path, 536_870_912) != release.read_regular(source, 536_870_912):
                raise ValueError("Selected pending release differs from its artifact")
            seen.add(relative)
    if seen != expected.keys():
        raise ValueError("Selected pending release is incomplete")


def install(manifest, artifact, fingerprint):
    prerequisites()
    root_directory(STATE, 0o700)
    lock = os.open(STATE / "install.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o7777 != 0o600:
            raise ValueError("Unsafe installation lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        accepted = admitted_release(manifest, fingerprint)
        runtime = BASE / "bin/bun"
        if runtime.is_symlink():
            if runtime.lstat().st_uid != 0 or os.readlink(runtime) != "../current/bin/bun":
                raise ValueError("Unsafe runtime release pointer")
        elif runtime.exists():
            raise ValueError("Unsafe runtime release pointer")
        root_directory(BASE)
        root_directory(BASE / "releases")
        with tempfile.TemporaryDirectory(prefix=".install-", dir=BASE / "releases") as temporary:
            unpacked = pathlib.Path(temporary)
            extract_verified(artifact, unpacked)
            bun = unpacked / "bin/bun"
            if release.command([str(bun), "--version"]).decode().strip() != release.BUN_VERSION:
                raise ValueError("Packaged Bun does not match the pinned runtime")
            stop_for_install()
            write_atomic(STATE / "release.json", json.dumps({**accepted, "status": "pending"}).encode(), 0o600)
            destination = BASE / "releases" / manifest["version"]
            current = BASE / "current"
            if current.exists() and not current.is_symlink():
                raise ValueError("Unsafe current release pointer")
            selected = destination.exists() and current.is_symlink() and current.resolve(strict=False) == destination
            if destination.exists() or destination.is_symlink():
                if destination.is_symlink() or not destination.is_dir() or destination.stat().st_uid != 0:
                    raise ValueError("Unsafe existing release directory")
                if selected:
                    verify_selected_release(destination, unpacked)
                else:
                    shutil.rmtree(destination)
            if not selected:
                staged = unpacked / "app"
                write_atomic(staged / "bin/bun", bun.read_bytes(), 0o755)
                for name in sorted(release.ASSETS):
                    write_atomic(staged / "deploy/linux" / name, (unpacked / "deploy/linux" / name).read_bytes(), 0o644)
                os.rename(staged, destination)
            sync_directory(destination.parent)
            root_directory(BASE / "bin")
            if not runtime.is_symlink():
                runtime.symlink_to("../current/bin/bun")
                sync_directory(runtime.parent)
            assets = unpacked / "deploy/linux"
            deployed_assets = destination / "deploy/linux"
            root_directory(deployed_assets)
            for name in sorted(release.ASSETS):
                target = pathlib.Path("/etc/systemd/system") / name if name.endswith((".service", ".socket")) else pathlib.Path("/etc/sysusers.d/paws-runner.conf") if name.endswith(".sysusers") else pathlib.Path("/etc/tmpfiles.d/paws-runner.conf") if name.endswith(".tmpfiles") else None
                if target is not None:
                    write_atomic(target, (assets / name).read_bytes(), 0o644)
            release.command(["/usr/bin/systemd-sysusers", "/etc/sysusers.d/paws-runner.conf"])
            release.command(["/usr/bin/systemd-tmpfiles", "--create", "/etc/tmpfiles.d/paws-runner.conf"])
            validate_identity_separation()
            runner = pwd.getpwnam("paws-runner")
            agent = pwd.getpwnam("paws-agent")
            runner_group = grp.getgrnam("paws-runner")
            agent_group = grp.getgrnam("paws-agent")
            results_group = grp.getgrnam("paws-results")
            check = pwd.getpwnam("paws-check")
            check_group = grp.getgrnam("paws-check")
            input_group = grp.getgrnam("paws-check-input")
            metadata_group = grp.getgrnam("paws-check-metadata")
            if runner.pw_uid <= 0 or agent.pw_uid <= 0 or runner.pw_uid == agent.pw_uid or runner.pw_gid != runner_group.gr_gid or agent.pw_gid != agent_group.gr_gid or runner.pw_gid == agent.pw_gid or runner.pw_shell != "/usr/sbin/nologin" or agent.pw_shell != "/usr/sbin/nologin" or runner.pw_dir != "/var/lib/paws-runner" or agent.pw_dir != "/var/lib/paws-agent" or "paws-agent" in runner_group.gr_mem:
                raise ValueError("Unsafe runner service identities")
            if check.pw_uid <= 0 or check.pw_uid in (runner.pw_uid, agent.pw_uid) or check.pw_gid != check_group.gr_gid or check.pw_gid in (runner.pw_gid, agent.pw_gid, input_group.gr_gid) or check.pw_shell != "/usr/sbin/nologin" or check.pw_dir != "/var/lib/paws-check" or "paws-runner" not in input_group.gr_mem or {"paws-agent", "paws-check"} & set(input_group.gr_mem) or {"paws-agent", "paws-check"} & set(runner_group.gr_mem):
                raise ValueError("Unsafe verification service identities")
            for path, uid, gid, mode in (("/var/lib/paws-check", check.pw_uid, check.pw_gid, 0o700), ("/var/lib/paws-check-input", runner.pw_uid, input_group.gr_gid, 0o2750), ("/var/lib/paws-check-attempts", 0, check.pw_gid, 0o750), ("/var/lib/paws-check-results", 0, runner.pw_gid, 0o750), ("/var/lib/paws-check-control", 0, 0, 0o700), ("/var/lib/paws-check-metadata", 0, metadata_group.gr_gid, 0o750), ("/var/lib/paws-check-broker", 0, 0, 0o700)):
                info = pathlib.Path(path).lstat()
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_gid != gid or info.st_mode & 0o7777 != mode:
                    raise ValueError(f"Unsafe verification installation state directory: {path}")
            for path, uid, gid, mode in (("/var/lib/paws-runner", runner.pw_uid, runner_group.gr_gid, 0o700), ("/var/lib/paws-agent", agent.pw_uid, agent_group.gr_gid, 0o700), ("/var/lib/paws-runner-spool", runner.pw_uid, agent_group.gr_gid, 0o2750), ("/var/lib/paws-agent-results", 0, results_group.gr_gid, 0o750), ("/var/lib/paws-runner-broker", 0, 0, 0o700)):
                info = pathlib.Path(path).lstat()
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_gid != gid or info.st_mode & 0o7777 != mode:
                    raise ValueError(f"Unsafe runner installation state directory: {path}")
            if "paws-runner" not in agent_group.gr_mem or not {"paws-runner", "paws-agent"} <= set(results_group.gr_mem):
                raise ValueError("Unsafe runner service identities")
            root_directory(pathlib.Path("/etc/paws-runner"))
            current = BASE / "current"
            if current.exists() and not current.is_symlink():
                raise ValueError("Unsafe current release pointer")
            temporary_pointer = BASE / ".current-pending"
            temporary_pointer.unlink(missing_ok=True)
            temporary_pointer.symlink_to(destination)
            os.replace(temporary_pointer, current)
            sync_directory(BASE)
            verifier_identity = json.loads(release.command(["/usr/bin/python3", "-I", "-B", str(deployed_assets / "check-verifier.py"), "initialize"]))
            release.command(["/usr/bin/systemctl", "daemon-reload"])
            release.command(["/usr/bin/systemctl", "enable", "paws-runner-broker.socket"])
            write_atomic(STATE / "release.json", json.dumps({**accepted, "status": "installed"}).encode(), 0o600)
        return {"installed": True, "version": manifest["version"], "releaseKeyFingerprint": fingerprint, "verifierIdentity": verifier_identity}
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser()
    for name in ("manifest", "signature", "artifact", "release-key"):
        parser.add_argument("--" + name, required=True)
    arguments = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="paws-release-") as temporary:
        manifest, artifact, fingerprint = release.verify_release(arguments, pathlib.Path(temporary))
        print(json.dumps(install(manifest, artifact, fingerprint)))


if __name__ == "__main__":
    main()
