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
import subprocess
import sys
import tempfile


spec = importlib.util.spec_from_file_location("paws_release", pathlib.Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
BASE = pathlib.Path("/opt/paws-runner")
STATE = pathlib.Path("/var/lib/paws-runner-install")
DEFAULT_REGISTRY = "https://registry.npmjs.org/"


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def adopt_tree(path, uid, gid, mode):
    info = path.lstat()
    os.lchown(path, uid, gid)
    if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
        os.chmod(path, mode)
        for child in path.iterdir():
            adopt_tree(child, uid, gid, stat.S_IMODE(child.lstat().st_mode))


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
    for name in ("paws-runner", "paws-agent"):
        try:
            accounts[name] = pwd.getpwnam(name)
        except KeyError:
            pass
    for name in ("paws-runner", "paws-agent", "paws-results", "paws-check-input"):
        try:
            groups[name] = grp.getgrnam(name).gr_gid
        except KeyError:
            pass
    identifiers = [account.pw_uid for account in accounts.values()]
    if any(identifier <= 0 for identifier in identifiers) or len(set(identifiers)) != len(identifiers) or any(identifier <= 0 for identifier in groups.values()) or len(set(groups.values())) != len(groups):
        raise ValueError("Runner service identities must be distinct")
    private_groups = {groups[name] for name in ("paws-runner", "paws-check-input") if name in groups}
    allowed_names = {"paws-runner": ("paws-runner", "paws-agent", "paws-results", "paws-check-input"), "paws-agent": ("paws-agent", "paws-results")}
    for name, account in accounts.items():
        membership = set(os.getgrouplist(name, account.pw_gid))
        if name != "paws-runner" and private_groups & membership:
            raise ValueError("Untrusted service identity belongs to a private runner group")
        allowed = {groups[group] for group in allowed_names[name] if group in groups}
        if not membership <= allowed:
            raise ValueError("Runner service identity has an unrelated supplemental group")


def prerequisites():
    if os.getuid() != 0:
        raise ValueError("Installation requires root")
    for path in ("/usr/bin/git", "/usr/bin/openssl", "/usr/bin/python3", "/usr/bin/flock", "/usr/sbin/runuser", "/usr/bin/env", "/usr/bin/systemctl", "/usr/bin/systemd-sysusers", "/usr/bin/systemd-tmpfiles"):
        resolved = pathlib.Path(path).resolve(strict=True)
        info = resolved.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or not info.st_mode & 0o001:
            raise ValueError("Unsafe or missing installation prerequisite")
        for parent in {pathlib.Path(path).parent, *pathlib.Path(path).parents, resolved.parent, *resolved.parents}:
            directory = parent.stat()
            if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o022 or not directory.st_mode & 0o001:
                raise ValueError("Unsafe or inaccessible prerequisite directory")
    if not release.command(["/usr/bin/openssl", "version"]).startswith(b"OpenSSL 3."):
        raise ValueError("OpenSSL 3 is required")
    release.command(["/usr/bin/git", "--version"])
    release.command(["/usr/bin/python3", "--version"])
    if not release.command(["/usr/bin/flock", "--version"]).startswith(b"flock from util-linux "):
        raise ValueError("util-linux flock is required at /usr/bin/flock")
    if not release.command(["/usr/sbin/runuser", "--version"]).startswith(b"runuser from util-linux "):
        raise ValueError("util-linux runuser is required at /usr/sbin/runuser")
    if b"--chdir" not in release.command(["/usr/bin/env", "--help"]):
        raise ValueError("GNU env with --chdir is required at /usr/bin/env")
    release.command(["/usr/bin/systemctl", "--version"])
    validate_identity_separation()


def admitted_release(manifest, fingerprint, reinstall=False):
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
    recovering = (previous["status"] == "pending" or reinstall) and all(previous[key] == value for key, value in accepted.items())
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
    existing = release.command(["/usr/bin/systemctl", "list-unit-files", "--no-legend", "--no-pager"]).decode()
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
                if member.name in release.BINARIES:
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
    for name in release.BINARIES:
        expected[pathlib.Path(name)] = unpacked / name
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


def install(manifest, artifact, fingerprint, reinstall=False):
    prerequisites()
    root_directory(STATE, 0o700)
    lock = os.open(STATE / "install.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o7777 != 0o600:
            raise ValueError("Unsafe installation lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        accepted = admitted_release(manifest, fingerprint, reinstall)
        # The provider launchers (claude, codex, ...) are written by activate_agents, not linked to the release.
        pointers = {"bun": "../current/bin/bun", "mise": "../current/bin/mise", "paws-runner": "../current/bin/paws-runner"}
        for name, target in pointers.items():
            pointer = BASE / "bin" / name
            if pointer.is_symlink():
                if pointer.lstat().st_uid != 0 or os.readlink(pointer) != target:
                    raise ValueError("Unsafe runtime release pointer")
            elif pointer.exists():
                raise ValueError("Unsafe runtime release pointer")
        root_directory(BASE)
        root_directory(BASE / "releases")
        with tempfile.TemporaryDirectory(prefix=".install-", dir=BASE / "releases") as temporary:
            unpacked = pathlib.Path(temporary)
            extract_verified(artifact, unpacked)
            bun = unpacked / "bin/bun"
            if release.read_regular(unpacked / "bin/paws-runner", 4096) != release.RUNNER_LAUNCHER:
                raise ValueError("Packaged runner is not the runner launcher")
            if release.command([str(bun), "--version"]).decode().strip() != release.BUN_VERSION:
                raise ValueError("Packaged Bun does not match the pinned runtime")
            release.verify_mise(release.read_regular(unpacked / "bin/mise", release.MISE_LIMIT), manifest["platform"])
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
                for name in release.BINARIES:
                    write_atomic(staged / name, (unpacked / name).read_bytes(), 0o755)
                for name in sorted(release.ASSETS):
                    write_atomic(staged / "deploy/linux" / name, (unpacked / "deploy/linux" / name).read_bytes(), 0o644)
                os.rename(staged, destination)
            sync_directory(destination.parent)
            root_directory(BASE / "bin")
            for name, target in pointers.items():
                pointer = BASE / "bin" / name
                if not pointer.is_symlink():
                    pointer.symlink_to(target)
                    sync_directory(pointer.parent)
            assets = unpacked / "deploy/linux"
            deployed_assets = destination / "deploy/linux"
            root_directory(deployed_assets)
            for name in sorted(release.ASSETS):
                target = pathlib.Path("/etc/systemd/system") / name if name.endswith((".service", ".socket")) else pathlib.Path("/etc/sysusers.d/paws-runner.conf") if name.endswith(".sysusers") else pathlib.Path("/etc/tmpfiles.d/paws-runner.conf") if name.endswith(".tmpfiles") else None
                if target is not None:
                    write_atomic(target, (assets / name).read_bytes(), 0o644)
            release.command(["/usr/bin/systemd-sysusers", "/etc/sysusers.d/paws-runner.conf"])
            release.command(["/usr/bin/systemd-tmpfiles", "--create", "/etc/tmpfiles.d/paws-runner.conf"])
            runner = pwd.getpwnam("paws-runner")
            results_group = grp.getgrnam("paws-results")
            adopt_tree(pathlib.Path("/var/lib/paws-agent"), runner.pw_uid, runner.pw_gid, 0o700)
            adopt_tree(pathlib.Path("/var/lib/paws-agent-tasks"), runner.pw_uid, runner.pw_gid, 0o711)
            adopt_tree(pathlib.Path("/var/lib/paws-agent-results"), runner.pw_uid, results_group.gr_gid, 0o750)
            shutil.rmtree("/var/lib/paws-runner-members", ignore_errors=True)
            validate_identity_separation()
            runner = pwd.getpwnam("paws-runner")
            agent = pwd.getpwnam("paws-agent")
            runner_group = grp.getgrnam("paws-runner")
            agent_group = grp.getgrnam("paws-agent")
            results_group = grp.getgrnam("paws-results")
            if runner.pw_uid <= 0 or agent.pw_uid <= 0 or runner.pw_uid == agent.pw_uid or runner.pw_gid != runner_group.gr_gid or agent.pw_gid != agent_group.gr_gid or runner.pw_gid == agent.pw_gid or runner.pw_shell != "/usr/sbin/nologin" or agent.pw_shell != "/usr/sbin/nologin" or runner.pw_dir != "/var/lib/paws-runner" or agent.pw_dir != "/var/lib/paws-agent" or "paws-agent" in runner_group.gr_mem:
                raise ValueError("Unsafe runner service identities")
            for path, uid, gid, mode in (("/var/lib/paws-runner", runner.pw_uid, runner_group.gr_gid, 0o700), ("/var/lib/paws-agent", runner.pw_uid, runner.pw_gid, 0o700), ("/var/lib/paws-runner-spool", runner.pw_uid, agent_group.gr_gid, 0o2750), ("/var/lib/paws-agent-tasks", runner.pw_uid, runner.pw_gid, 0o711), ("/var/lib/paws-agent-results", runner.pw_uid, results_group.gr_gid, 0o750)):
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
            release.command(["/usr/bin/systemctl", "daemon-reload"])
            retired = ("paws-runner-broker.socket", "paws-runner-broker.service", "paws-check@.service", "paws-check-witness@.service")
            present = [name for name in retired if pathlib.Path("/etc/systemd/system", name).exists()]
            if present:
                if "paws-runner-broker.socket" in present:
                    release.command(["/usr/bin/systemctl", "disable", "--now", "--", "paws-runner-broker.socket"])
                stop = [name for name in present if "@" not in name and name != "paws-runner-broker.socket"]
                if stop:
                    release.command(["/usr/bin/systemctl", "stop", "--", *stop])
                for name in present:
                    pathlib.Path("/etc/systemd/system", name).unlink()
                release.command(["/usr/bin/systemctl", "daemon-reload"])
            write_atomic(STATE / "release.json", json.dumps({**accepted, "status": "installed"}).encode(), 0o600)
        login_prefix = "/usr/sbin/runuser --user paws-runner -- /usr/bin/env -i --chdir=/var/lib/paws-agent HOME=/var/lib/paws-agent PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C "
        login_commands = {"claude": login_prefix + "/opt/paws-runner/bin/claude auth login", "codex": login_prefix + "/opt/paws-runner/bin/codex login --device-auth"}
        return {"installed": True, "version": manifest["version"], "releaseKeyFingerprint": fingerprint, "providerLoginCommands": login_commands}
    finally:
        os.close(lock)


class AgentInstallError(ValueError):
    def __init__(self, agent, version, detail):
        super().__init__(f"Coding agent {agent} {version} was not installed: {detail}")
        self.agent = agent


def read_member(artifact, members, name, limit):
    member = members[name]
    if member.size > limit:
        raise ValueError("Release member exceeds size limit")
    with artifact.open("rb") as incoming:
        incoming.seek(member.offset_data)
        content = incoming.read(member.size)
    if len(content) != member.size:
        raise ValueError("Truncated verified artifact")
    return content


def lock_agents():
    root_directory(STATE, 0o700)
    lock = os.open(STATE / "agents.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(lock)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o7777 != 0o600:
        os.close(lock)
        raise ValueError("Unsafe agent installation lock")
    fcntl.flock(lock, fcntl.LOCK_EX)
    return lock


def installed_package_path(relative):
    """node_modules path of a package root -> its bun.lock key: a/node_modules/@b/c -> a/@b/c."""
    return "/".join(release.package_names(relative.split("/")))


def package_root(parts):
    """True for node_modules-relative parts naming a package folder: a, @s/a, a/node_modules/b."""
    if parts[-1] in ("node_modules", ".bin") or parts[-1].startswith("@"):
        return False
    if len(parts) >= 2 and parts[-2].startswith("@"):
        return len(parts) == 2 or parts[-3] == "node_modules"
    return len(parts) == 1 or parts[-2] == "node_modules"


def check_agent_tree(agent, entry, root):
    """The staged install holds exactly the pinned packages, nothing links out, and every launcher target is the expected kind."""
    pinned = {item["path"]: item for item in entry["packages"]}
    modules = root / "node_modules"
    for current, directories, files in os.walk(root, followlinks=False):
        current = pathlib.Path(current)
        for name in [*directories, *files]:
            path = current / name
            if path.is_symlink():
                target = (path.parent / os.readlink(path)).resolve(strict=False)
                if not target.is_relative_to(root.resolve()):
                    raise AgentInstallError(agent, entry["version"], f"{path.relative_to(root)} links outside the agent folder")
            elif not (path.is_dir() or path.is_file()):
                raise AgentInstallError(agent, entry["version"], f"{path.relative_to(root)} is not a regular file")
        if current.is_relative_to(modules) and current != modules and package_root(current.relative_to(modules).parts):
            key = installed_package_path(current.relative_to(modules).as_posix())
            item = pinned.get(key)
            try:
                version = json.loads(release.read_regular(current / "package.json", 16_777_216)).get("version")
            except (OSError, ValueError, AttributeError):
                version = None
            if item is None or version != item["version"]:
                raise AgentInstallError(agent, entry["version"], f"{key} is not a pinned package")
    for name, (owner, target, script) in release.PROVIDER_EXECUTABLES.items():
        if owner != agent:
            continue
        path = root / target
        if path.is_symlink() or not path.is_file():
            raise AgentInstallError(agent, entry["version"], f"{target} is missing")
        first = release.read_regular(path, 536_870_912).split(b"\n", 1)[0]
        node = first.startswith(b"#!") and b"node" in first
        if node != script or not script and not path.stat().st_mode & 0o111:
            raise AgentInstallError(agent, entry["version"], f"{target} is not the expected {'node script' if script else 'executable'}")
    for target in release.AGENT_NATIVE[agent]:
        path = root / target
        if path.is_symlink() or not path.is_file() or not path.stat().st_mode & 0o111:
            raise AgentInstallError(agent, entry["version"], f"{target} is missing or not executable")


def trim_agent_tree(agent, root):
    """Remove what no runner session uses: Codex's voice host and the musl builds a glibc host never loads."""
    for target in release.AGENT_DROPPED[agent]:
        shutil.rmtree(root / target, ignore_errors=True)
    modules = root / "node_modules"
    for current, directories, _ in os.walk(modules, followlinks=False):
        for name in list(directories):
            path = pathlib.Path(current) / name
            # Only whole packages: Codex keeps its own native build under vendor/<triple>-linux-musl.
            if name.endswith("-musl") and not path.is_symlink() and package_root(path.relative_to(modules).parts):
                shutil.rmtree(pathlib.Path(current) / name)
                directories.remove(name)
    for link in (modules / ".bin").glob("*") if (modules / ".bin").is_dir() else ():
        if link.is_symlink() and not link.exists():
            link.unlink()


def normalize_modes(root):
    for current, directories, files in os.walk(root, followlinks=False):
        os.chmod(current, 0o755)
        for name in files:
            path = pathlib.Path(current) / name
            if not path.is_symlink():
                os.chmod(path, 0o755 if path.stat().st_mode & 0o111 else 0o644)
    for current, _, _ in os.walk(root, topdown=False, followlinks=False):
        sync_directory(current)


def install_agent_version(agent, entry, bun, base=BASE, registry=DEFAULT_REGISTRY):
    """Install one agent version into base/agents/<agent>/<version>. An installed version is never changed."""
    version = entry["version"]
    folder = base / "agents" / agent
    root_directory(folder)
    destination = folder / version
    if destination.is_symlink() or destination.exists() and not destination.is_dir():
        raise AgentInstallError(agent, version, "the version folder is not a directory")
    if destination.is_dir():
        return destination
    # Callers hold the agent lock, so a staging folder left here is from an install that was killed.
    for stale in [*folder.glob(".install-*"), *folder.glob(".home-*")]:
        if stale.is_dir() and not stale.is_symlink():
            shutil.rmtree(stale)
    staging = pathlib.Path(tempfile.mkdtemp(prefix=f".install-{version}-", dir=folder))
    home = pathlib.Path(tempfile.mkdtemp(prefix=".home-", dir=folder))
    try:
        (staging / "package.json").write_text(json.dumps(release.agent_package_json(agent, version)))
        (staging / "bun.lock").write_text(json.dumps(entry["lockfile"], indent=2) + "\n")
        completed = subprocess.run(
            [str(bun), "install", "--frozen-lockfile", "--ignore-scripts", "--production", "--linker=hoisted", "--backend=copyfile", "--no-progress"],
            cwd=staging,
            env={**release.COMMAND_ENV, "HOME": str(home), "BUN_INSTALL_CACHE_DIR": str(home / "cache"), "BUN_CONFIG_REGISTRY": registry},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=1800,
        )
        if completed.returncode != 0:
            detail = " ".join(completed.stderr.decode(errors="replace").splitlines()[-6:])[:600] or f"bun install exited {completed.returncode}"
            raise AgentInstallError(agent, version, detail)
        check_agent_tree(agent, entry, staging)
        trim_agent_tree(agent, staging)
        normalize_modes(staging)
        os.rename(staging, destination)
        sync_directory(folder)
        return destination
    except subprocess.TimeoutExpired as error:
        raise AgentInstallError(agent, version, "bun install timed out") from error
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(home, ignore_errors=True)


def install_agents(manifest, bun, base=BASE, registry=DEFAULT_REGISTRY):
    """Install every pinned agent version beside the ones already there. Nothing switches until all succeed."""
    for agent in sorted(manifest["agents"]):
        install_agent_version(agent, manifest["agents"][agent], bun, base, registry)
    return manifest


def held(path):
    """True while a launcher's shared lock on the version folder is open."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return False
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return False
    except BlockingIOError:
        return True
    finally:
        os.close(descriptor)


def switch_current(folder, version):
    """Point folder/current at version once no session holds the version it points at now."""
    current = folder / "current"
    if current.exists() and not current.is_symlink():
        raise ValueError(f"Unsafe agent pointer: {current}")
    if current.is_symlink():
        previous = os.readlink(current)
        if previous == version:
            return "installed"
        if "/" in previous or previous in ("", ".", ".."):
            raise ValueError(f"Unsafe agent pointer: {current}")
        old = folder / previous
        try:
            descriptor = os.open(old, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except FileNotFoundError:
            descriptor = None
        try:
            if descriptor is not None:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return "waiting"
            replace_link(current, version)
        finally:
            if descriptor is not None:
                os.close(descriptor)
    else:
        replace_link(current, version)
    return "installed"


def replace_link(path, target):
    pending = path.with_name(".current-pending")
    pending.unlink(missing_ok=True)
    pending.symlink_to(target)
    os.replace(pending, path)
    sync_directory(path.parent)


def activate_agents(manifest, base=BASE):
    """Write the provider launchers and move each agent's current pointer to its pinned version."""
    statuses = {}
    for name in sorted(release.PROVIDER_EXECUTABLES):
        write_atomic(base / "bin" / name, release.agent_launcher(name, str(base)), 0o755)
    for agent, entry in sorted(manifest["agents"].items()):
        folder = base / "agents" / agent
        if not (folder / entry["version"]).is_dir():
            raise AgentInstallError(agent, entry["version"], "the version folder is missing")
        statuses[agent] = {"version": entry["version"], "status": switch_current(folder, entry["version"])}
    return statuses


def prepare_agents(artifact, base=BASE, registry=DEFAULT_REGISTRY):
    """Install the release's pinned agents with the release's own Bun, before the release is put in place."""
    members = release.inspect_archive(artifact)
    manifest = release.parse_agent_manifest(read_member(artifact, members, "deploy/linux/agents.json", release.AGENT_MANIFEST_LIMIT))
    lock = lock_agents()
    try:
        with tempfile.TemporaryDirectory(prefix="agents-bun-", dir=STATE) as temporary:
            bun = pathlib.Path(temporary) / "bun"
            with bun.open("xb") as stream:
                stream.write(read_member(artifact, members, "bin/bun", 536_870_912))
            bun.chmod(0o700)
            if release.command([str(bun), "--version"]).decode().strip() != release.BUN_VERSION:
                raise ValueError("Packaged Bun does not match the pinned runtime")
            return install_agents(manifest, bun, base, registry)
    finally:
        os.close(lock)


def finish_agents(manifest, base=BASE):
    lock = lock_agents()
    try:
        return activate_agents(manifest, base)
    finally:
        os.close(lock)


def agents_from_current(base=BASE):
    """Install and activate the agents pinned by the installed release, for example after a waiting switch."""
    prerequisites()
    manifest = release.parse_agent_manifest(release.read_regular(base / "current/deploy/linux/agents.json", release.AGENT_MANIFEST_LIMIT))
    lock = lock_agents()
    try:
        install_agents(manifest, base / "bin/bun", base)
        return activate_agents(manifest, base)
    finally:
        os.close(lock)


def main():
    if sys.argv[1:] == ["agents"]:
        print(json.dumps({"agents": agents_from_current()}))
        return
    parser = argparse.ArgumentParser()
    for name in ("manifest", "signature", "artifact", "release-key"):
        parser.add_argument("--" + name, required=True)
    arguments = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="paws-release-") as temporary:
        manifest, artifact, fingerprint = release.verify_release(arguments, pathlib.Path(temporary))
        prerequisites()
        agents = prepare_agents(artifact)
        installed = install(manifest, artifact, fingerprint)
        installed["agents"] = finish_agents(agents)
        print(json.dumps(installed))


if __name__ == "__main__":
    main()
