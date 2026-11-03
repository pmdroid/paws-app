import argparse
import fcntl
import importlib.util
import json
import os
import pathlib
import pwd
import grp
import hashlib
import shutil
import stat
import subprocess
import sys
import tempfile
import time


spec = importlib.util.spec_from_file_location("paws_release", pathlib.Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
BASE = pathlib.Path("/opt/paws-runner")
STATE = pathlib.Path("/var/lib/paws-runner-install")
DEFAULT_REGISTRY = "https://registry.npmjs.org/"
# The runner daemon writes the agent versions Paws sent it here; paws-runner-agents.path starts
# `install.py agent-requests` when it changes. Root writes what happened to AGENT_STATUS, which the
# daemon reads and reports in its heartbeat.
AGENT_REQUESTS = pathlib.Path("/var/lib/paws-runner/agent-requests.json")
AGENT_STATUS = pathlib.Path("/var/lib/paws-runner-agents/status.json")
AGENT_REQUEST_LIMIT = 65_536
# Inside each version folder: the packages its lockfile installed, with their sha512.
AGENT_PACKAGE_RECORD = ".paws-packages.json"
AGENT_POLL_SECONDS = 5


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


def approved_docker_gid(groups):
    """The docker group's id when paws-runner may belong to it: a real group no other name or Paws group shares."""
    try:
        docker = grp.getgrnam(DOCKER_GROUP)
    except KeyError:
        return None
    if docker.gr_gid <= 0 or docker.gr_gid in groups.values():
        return None
    if any(group.gr_gid == docker.gr_gid and group.gr_name != DOCKER_GROUP for group in grp.getgrall()):
        return None
    return docker.gr_gid


def service_groups():
    groups = {}
    for name in ("paws-runner", "paws-agent", "paws-results", "paws-check-input"):
        try:
            groups[name] = grp.getgrnam(name).gr_gid
        except KeyError:
            pass
    return groups


def validate_identity_separation():
    accounts = {}
    for name in ("paws-runner", "paws-agent"):
        try:
            accounts[name] = pwd.getpwnam(name)
        except KeyError:
            pass
    groups = service_groups()
    identifiers = [account.pw_uid for account in accounts.values()]
    if any(identifier <= 0 for identifier in identifiers) or len(set(identifiers)) != len(identifiers) or any(identifier <= 0 for identifier in groups.values()) or len(set(groups.values())) != len(groups):
        raise ValueError("Runner service identities must be distinct")
    private_groups = {groups[name] for name in ("paws-runner", "paws-check-input") if name in groups}
    allowed_names = {"paws-runner": ("paws-runner", "paws-agent", "paws-results", "paws-check-input"), "paws-agent": ("paws-agent", "paws-results")}
    # An earlier release could add paws-runner to the docker group (PAS-1024). Paws now removes only the membership
    # it recorded adding (`docker_group_membership`), so an install tolerates one it did not add instead of failing.
    docker = approved_docker_gid(groups)
    for name, account in accounts.items():
        membership = set(os.getgrouplist(name, account.pw_gid))
        if name != "paws-runner" and private_groups & membership:
            raise ValueError("Untrusted service identity belongs to a private runner group")
        allowed = {groups[group] for group in allowed_names[name] if group in groups}
        if name == "paws-runner" and docker is not None:
            allowed.add(docker)
        if not membership <= allowed:
            raise ValueError("Runner service identity has an unrelated supplemental group")


# Docker access for runner work: a rootless Docker daemon that runs as paws-agent. Its socket directory
# is open to the paws-agent group, which paws-runner (and so every worker it launches) belongs to; the
# supervisor gives workers DOCKER_HOST when the socket exists (runnerDockerEnv in
# src/runner-execution/supervisor.ts), and the drop-in gives it to paws-agent@.service. No runner work
# needs the root daemon at /var/run/docker.sock. The package never installs Docker or its rootless tools.
DOCKER_GROUP = "docker"
DOCKER_ACCESS_ENV = "PAWS_RUNNER_DOCKER_ACCESS"
DOCKER_RISK = "Members of the docker group control the Docker daemon, which runs as root: every agent and check this runner executes can then act as root on this host, and the runner's systemd hardening does not contain it."
# The PATH the daemon unit runs with; the prerequisites must be on it.
DOCKER_PATH = "/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin"
DOCKER_PREREQUISITES = (("rootlesskit", "rootlesskit"), ("newuidmap", "uidmap"), ("newgidmap", "uidmap"), ("slirp4netns", "slirp4netns"))
DOCKER_LAUNCHER = pathlib.Path("/usr/lib/paws-runner-package/dockerd-rootless.sh")
DOCKER_UNIT = pathlib.Path("/etc/systemd/system/paws-docker.service")
DOCKER_DROP_IN = pathlib.Path("/etc/systemd/system/paws-agent@.service.d/docker.conf")
DOCKER_DATA = pathlib.Path("/var/lib/paws-agent-docker")
DOCKER_SUBORDINATE = {"uid": pathlib.Path("/etc/subuid"), "gid": pathlib.Path("/etc/subgid")}
DOCKER_SUBORDINATE_COUNT = 65536
DOCKER_SOCKET = "/run/paws-docker/docker.sock"
# PAS-1024 recorded here that it added paws-runner to the docker group; only that membership is removed.
DOCKER_GROUP_GRANT = STATE / "docker-group.json"
SYSTEMCTL = "/usr/bin/systemctl"
USERMOD = "/usr/sbin/usermod"
GPASSWD = "/usr/bin/gpasswd"
DOCKER_UNIT_CONTENT = f"""[Unit]
Description=Rootless Docker daemon for paws-agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=paws-agent
Group=paws-agent
RuntimeDirectory=paws-docker
RuntimeDirectoryMode=0750
Environment=XDG_RUNTIME_DIR=/run/paws-docker
Environment=HOME={DOCKER_DATA}
Environment=PATH={DOCKER_PATH}
ExecStart={DOCKER_LAUNCHER} --data-root {DOCKER_DATA}/data --exec-root /run/paws-docker/exec --pidfile /run/paws-docker/docker.pid --host unix://{DOCKER_SOCKET} --exec-opt native.cgroupdriver=cgroupfs
Delegate=yes
KillMode=mixed
Restart=on-failure
RestartSec=5s
LimitNOFILE=infinity
LimitNPROC=infinity
TasksMax=infinity

[Install]
WantedBy=multi-user.target
"""
DOCKER_DROP_IN_CONTENT = f"""[Unit]
Wants=paws-docker.service
After=paws-docker.service
[Service]
Environment=DOCKER_HOST=unix://{DOCKER_SOCKET}
"""
# Asks the daemon for its version over the socket, with a bounded wait. It changes nothing.
DOCKER_PROBE = r'''
import json, socket, sys
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout(5)
try:
    client.connect(sys.argv[1])
    client.sendall(b"GET /version HTTP/1.0\r\nHost: docker\r\n\r\n")
    response = b""
    while len(response) < 65536:
        chunk = client.recv(65536)
        if not chunk:
            break
        response += chunk
except PermissionError:
    print("permission-denied")
    sys.exit()
except (OSError, socket.timeout):
    print("daemon-unavailable")
    sys.exit()
head, _, body = response.partition(b"\r\n\r\n")
if not head.startswith(b"HTTP/1.") or head.split(b" ", 2)[1:2] != [b"200"]:
    print("daemon-unavailable")
    sys.exit()
try:
    components = [item.get("Name") for item in json.loads(body).get("Components") or []]
except (ValueError, AttributeError):
    components = []
print("ready" if "Engine" in components else "alternative-runtime")
'''


def docker_access_choice(environ=os.environ):
    """`grant`, `deny` or None from PAWS_RUNNER_DOCKER_ACCESS. Package configuration never prompts."""
    value = environ.get(DOCKER_ACCESS_ENV, "")
    if value not in ("", "grant", "deny"):
        raise ValueError(f"{DOCKER_ACCESS_ENV} must be grant or deny")
    return value or None


def docker_report(status, message, changed=False):
    return {"status": status, "changed": changed, "message": message}


def run_tool(arguments, timeout=60):
    """Run a host tool as root; return None, or what it printed when it failed."""
    result = subprocess.run(arguments, env=release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    if result.returncode != 0:
        return " ".join(result.stderr.decode(errors="replace").split())[:300] or f"{pathlib.Path(arguments[0]).name} exited {result.returncode}"
    return None


def docker_probe():
    """What runner work sees at the rootless socket, as paws-runner, waiting up to 30 seconds for the daemon."""
    outcome = "daemon-unavailable"
    for _ in range(30):
        try:
            result = subprocess.run(["/usr/sbin/runuser", "--user", "paws-runner", "--", "/usr/bin/env", "-i", "PATH=" + DOCKER_PATH, "LANG=C.UTF-8", "/usr/bin/python3", "-I", "-B", "-c", DOCKER_PROBE, DOCKER_SOCKET], env=release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
        except subprocess.TimeoutExpired:
            return outcome
        outcome = result.stdout.decode(errors="replace").strip() if result.returncode == 0 else "daemon-unavailable"
        if outcome != "daemon-unavailable":
            return outcome
        time.sleep(1)
    return outcome


def next_subordinate_start(content):
    """The first 65536-aligned id at or past the end of the highest range in /etc/subuid or /etc/subgid."""
    end = 0
    for line in content.splitlines():
        fields = line.strip().split(":")
        if len(fields) == 3 and fields[1].isdigit() and fields[2].isdigit():
            end = max(end, int(fields[1]) + int(fields[2]))
    if end == 0:
        return 100000
    return -(-end // DOCKER_SUBORDINATE_COUNT) * DOCKER_SUBORDINATE_COUNT


def add_subordinate_ids():
    """Give paws-agent one 65536-id range in /etc/subuid and /etc/subgid where it has none. Returns the files it changed."""
    added = []
    for kind, path in DOCKER_SUBORDINATE.items():
        try:
            content = path.read_text()
        except FileNotFoundError:
            content = ""
        if any(line.startswith("paws-agent:") for line in content.splitlines()):
            continue
        start = next_subordinate_start(content)
        failure = run_tool([USERMOD, f"--add-sub{kind}s", f"{start}-{start + DOCKER_SUBORDINATE_COUNT - 1}", "paws-agent"])
        if failure is not None:
            raise ValueError(f"Could not add subordinate {kind}s for paws-agent: {failure}")
        added.append(str(path))
    return added


def docker_data_directory(agent):
    """`install -d -o paws-agent -g paws-agent -m 0700`, refusing a path that is not a directory."""
    created = False
    try:
        DOCKER_DATA.mkdir(mode=0o700)
        created = True
    except FileExistsError:
        pass
    descriptor = os.open(DOCKER_DATA, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (agent.pw_uid, agent.pw_gid, 0o700):
            os.fchown(descriptor, agent.pw_uid, agent.pw_gid)
            os.fchmod(descriptor, 0o700)
            created = True
    finally:
        os.close(descriptor)
    return created


def write_if_changed(path, content):
    try:
        if path.read_bytes() == content.encode():
            return False
    except FileNotFoundError:
        pass
    write_atomic(path, content.encode(), 0o644)
    return True


def remove_rootless_docker():
    """Stop and remove the daemon unit and the drop-in. The data directory and subordinate ids stay."""
    present = [path for path in (DOCKER_UNIT, DOCKER_DROP_IN) if path.exists() or path.is_symlink()]
    if not present:
        return False
    if DOCKER_UNIT in present:
        run_tool([SYSTEMCTL, "disable", "--now", "--", DOCKER_UNIT.name])
    for path in present:
        path.unlink()
    release.command([SYSTEMCTL, "daemon-reload"])
    return True


def rootless_docker(choice):
    """Set up, keep or remove the rootless Docker daemon for paws-agent.

    `grant` sets it up when Docker Engine and its rootless tools are installed; `deny`, or a host
    without Docker Engine, removes it. Without a choice an existing setup is kept and refreshed.
    Runs as root after the service identities exist. It never installs a package.
    """
    try:
        agent = pwd.getpwnam("paws-agent")
    except KeyError:
        return docker_report("missing-account", "The paws-agent service account does not exist; install the runner package first.")
    configured = DOCKER_UNIT.exists()
    if shutil.which("dockerd", path=DOCKER_PATH) is None:
        removed = remove_rootless_docker()
        return docker_report("absent", "Docker Engine is not installed" + ("; removed the rootless Docker daemon for agent jobs." if removed else "; nothing changed."), removed)
    if choice == "deny" or choice is None and not configured:
        removed = remove_rootless_docker()
        intro = "Docker access was declined" if choice == "deny" else "Agent jobs cannot use Docker"
        done = "removed the rootless Docker daemon for agent jobs; its images and data stay" if removed else "nothing changed"
        return docker_report("declined" if choice == "deny" else "opt-in-required", f"{intro}; {done}. To give agent jobs a rootless Docker daemon of their own: sudo {DOCKER_ACCESS_ENV}=grant dpkg-reconfigure paws-runner", removed)
    missing = sorted({package for command, package in DOCKER_PREREQUISITES if shutil.which(command, path=DOCKER_PATH) is None})
    if missing:
        return docker_report("missing-prerequisites", f"Rootless Docker for agent jobs needs {', '.join(missing)}; nothing changed. Install them (sudo apt-get install {' '.join(missing)}), then reconfigure the runner.")
    try:
        launcher = release.read_regular(DOCKER_LAUNCHER, 1_048_576)
    except FileNotFoundError:
        launcher = None
    if launcher is None or hashlib.sha256(launcher).hexdigest() != release.DOCKERD_ROOTLESS_SHA256:
        return docker_report("missing-launcher", f"{DOCKER_LAUNCHER} is missing or not the launcher this package ships; nothing changed. Reinstall the paws-runner package.")
    changed = bool(add_subordinate_ids())
    changed = docker_data_directory(agent) or changed
    files = write_if_changed(DOCKER_UNIT, DOCKER_UNIT_CONTENT)
    files = write_if_changed(DOCKER_DROP_IN, DOCKER_DROP_IN_CONTENT) or files
    if files:
        # A daemon already running from an older unit starts again with the new one.
        release.command([SYSTEMCTL, "daemon-reload"])
        failure = run_tool([SYSTEMCTL, "enable", "--", DOCKER_UNIT.name]) or run_tool([SYSTEMCTL, "restart", "--", DOCKER_UNIT.name], timeout=120)
    else:
        failure = run_tool([SYSTEMCTL, "enable", "--now", "--", DOCKER_UNIT.name], timeout=120)
    changed = changed or files
    if failure is not None:
        return docker_report("start-failed", f"Could not start paws-docker.service: {failure}. Check journalctl -u paws-docker.service; agent jobs cannot use Docker until it runs.", changed)
    probe = docker_probe()
    if probe == "ready":
        return docker_report("granted" if changed else "ready", ("Set up" if changed else "Kept") + f" a rootless Docker daemon for agent jobs (paws-docker.service, running as paws-agent at {DOCKER_SOCKET}); new runner work gets DOCKER_HOST for it.", changed)
    if probe == "daemon-unavailable":
        return docker_report("daemon-unavailable", f"paws-docker.service is enabled, but the daemon at {DOCKER_SOCKET} did not answer. Check journalctl -u paws-docker.service; agent jobs cannot use Docker until it does.", changed)
    return docker_report(probe, f"paws-docker.service is enabled, but paws-runner could not use the daemon at {DOCKER_SOCKET} ({probe}). Check that paws-runner is in the paws-agent group and journalctl -u paws-docker.service.", changed)


def docker_group_membership():
    """Undo PAS-1024's grant of the root docker group to paws-runner, but only where Paws recorded adding it."""
    try:
        docker = grp.getgrnam(DOCKER_GROUP)
        runner = pwd.getpwnam("paws-runner")
    except KeyError:
        DOCKER_GROUP_GRANT.unlink(missing_ok=True)
        return None
    member = docker.gr_gid in os.getgrouplist("paws-runner", runner.pw_gid)
    try:
        recorded = json.loads(release.read_regular(DOCKER_GROUP_GRANT, 4096)).get("added") is True
    except FileNotFoundError:
        recorded = False
    if recorded and member:
        failure = run_tool([GPASSWD, "-d", "paws-runner", DOCKER_GROUP])
        if failure is not None:
            return docker_report("group-removal-failed", f"Could not remove paws-runner from the {DOCKER_GROUP} group that Paws added it to: {failure}. Remove it with gpasswd -d paws-runner {DOCKER_GROUP}. {DOCKER_RISK}")
        DOCKER_GROUP_GRANT.unlink()
        return docker_report("group-removed", f"Removed paws-runner from the {DOCKER_GROUP} group that an earlier Paws release added it to; agent jobs use rootless Docker instead.", True)
    if recorded:
        DOCKER_GROUP_GRANT.unlink()
    if member:
        return docker_report("group-kept", f"paws-runner is in the {DOCKER_GROUP} group, and Paws did not add it, so it was left alone. {DOCKER_RISK} Remove it with gpasswd -d paws-runner {DOCKER_GROUP} if nothing else needs it.")
    return None


def configure_docker_access(choice):
    """`rootless_docker` for an installer: a failed step is reported, not raised, so the runner service still comes back."""
    try:
        group = docker_group_membership()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        group = docker_report("group-check-failed", f"Could not check paws-runner's {DOCKER_GROUP} group membership: {' '.join(str(error).split())[:300]}.")
    try:
        report = rootless_docker(choice)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        report = docker_report("check-failed", f"Could not set up Docker for agent jobs: {' '.join(str(error).split())[:300]}. Agent jobs may not be able to use Docker; reconfigure the runner to try again.")
    if group is not None:
        print("Docker access: " + group["message"], file=sys.stderr)
        report["dockerGroup"] = group
    print("Docker access: " + report["message"], file=sys.stderr)
    return report


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
                target = pathlib.Path("/etc/systemd/system") / name if name.endswith((".service", ".socket", ".path")) else pathlib.Path("/etc/sysusers.d/paws-runner.conf") if name.endswith(".sysusers") else pathlib.Path("/etc/tmpfiles.d/paws-runner.conf") if name.endswith(".tmpfiles") else None
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
        # What this folder installed, with each package's sha512, so a later request for this version
        # is checked against the bytes that are here (`installed_agent_packages`).
        (staging / AGENT_PACKAGE_RECORD).write_text(json.dumps(entry["packages"], sort_keys=True))
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
    """Write the provider launchers and move each agent's current pointer to its pinned version, unless it already points at a newer one."""
    statuses = {}
    for name in sorted(release.PROVIDER_EXECUTABLES):
        write_atomic(base / "bin" / name, release.agent_launcher(name, str(base)), 0o755)
    for agent, entry in sorted(manifest["agents"].items()):
        folder = base / "agents" / agent
        if not (folder / entry["version"]).is_dir():
            raise AgentInstallError(agent, entry["version"], "the version folder is missing")
        active = current_agent_version(folder)
        if active is not None and (folder / active).is_dir() and newer(active, entry["version"]):
            statuses[agent] = {"version": active, "status": "kept"}
            continue
        statuses[agent] = {"version": entry["version"], "status": switch_current(folder, entry["version"])}
    return statuses


def newer(version, than):
    """Whether one exact version sorts after another; a pre-release sorts before its release."""
    def key(value):
        match = release.EXACT_VERSION.fullmatch(value)
        core = tuple(int(part) for part in match.groups())
        return core + ((0,) if "-" in value else (1,))
    return key(version) > key(than)


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


def current_agent_version(folder):
    """The version folder/current points at, or None."""
    current = folder / "current"
    if not current.is_symlink():
        return None
    target = os.readlink(current)
    return target if release.EXACT_VERSION.fullmatch(target) else None


def holders(path, locks=pathlib.Path("/proc/locks")):
    """How many sessions hold a shared flock on the version folder: one per launcher, inherited by what it starts."""
    try:
        info = os.stat(path)
        lines = locks.read_text().splitlines()
    except OSError:
        return 0
    wanted = (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino)
    count = 0
    for line in lines:
        # "1: FLOCK  ADVISORY  READ  1234 fd:01:5678 0 EOF"; a blocked request reads "1: -> FLOCK ...".
        fields = line.split()
        if len(fields) < 6 or fields[1] != "FLOCK" or fields[3] != "READ":
            continue
        try:
            major, minor, inode = fields[5].split(":")
            key = (int(major, 16), int(minor, 16), int(inode))
        except ValueError:
            continue
        if key == wanted:
            count += 1
    return count


def read_agent_requests(path=AGENT_REQUESTS):
    """The requests the runner forwarded from Paws, or [] when there are none."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return []
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > AGENT_REQUEST_LIMIT:
            raise ValueError("Invalid agent request file")
        content = os.read(descriptor, AGENT_REQUEST_LIMIT + 1)
    finally:
        os.close(descriptor)
    return release.parse_agent_requests(content)


def read_agent_status(path=AGENT_STATUS):
    try:
        status = json.loads(release.read_regular(path, AGENT_REQUEST_LIMIT))
    except (FileNotFoundError, ValueError):
        return {"format": 1, "agents": {}}
    if not isinstance(status, dict) or status.get("format") != 1 or not isinstance(status.get("agents"), dict):
        return {"format": 1, "agents": {}}
    return status


def verify_requested_packages(request, packages):
    """Refuse unless `packages` (path, name, version, integrity) holds exactly what Paws sent.

    The agent package must carry the integrity Paws sent. The native build package and each platform
    package Paws listed must carry the sha512 the catalog checked: any package of one of those names
    with another version or other bytes is refused.
    """
    agent, version = request["agent"], request["version"]
    package = release.AGENT_PACKAGES[agent]
    top = [item for item in packages if item["name"] == package and item["version"] == version]
    if not top or any(item["integrity"] != request["integrity"] for item in top):
        raise AgentInstallError(agent, version, f"npm's integrity for {package}@{version} is not the one Paws sent")
    native = release.AGENT_NATIVE_PACKAGE[agent]
    if request["nativeVersion"] is not None and native != package:
        platform_build = request["nativeVersion"] + "-"
        found = sorted({item["version"] for item in packages if item["name"] == native and not item["version"].startswith(platform_build)})
        if found != [request["nativeVersion"]]:
            raise AgentInstallError(agent, version, f"it resolves {native}@{', '.join(found) or 'nothing'}, not {request['nativeVersion']} as Paws checked")
        if not any(pin["name"] == native and pin["version"] == request["nativeVersion"] for pin in request["packages"]):
            raise AgentInstallError(agent, version, f"Paws sent no integrity for {native}@{request['nativeVersion']}")
    checked = {}
    for pin in request["packages"]:
        checked.setdefault(pin["name"], {})[pin["version"]] = pin["integrity"]
    for item in packages:
        expected = checked.get(item["name"])
        if expected is not None and expected.get(item["version"]) != item["integrity"]:
            raise AgentInstallError(agent, version, f"{item['name']}@{item['version']} does not carry the integrity Paws checked")


def resolve_requested_agent(request, bun, registry):
    """Resolve the requested version's lockfile and check it installs exactly what Paws sent."""
    agent, version = request["agent"], request["version"]
    package = release.AGENT_PACKAGES[agent]
    with tempfile.TemporaryDirectory(prefix="agent-resolve-", dir=STATE) as workspace:
        try:
            # The catalog checked one native build version inside the adapter's range; resolve exactly
            # that one, not a newer release that may still be inside its 48 hours.
            native = release.AGENT_NATIVE_PACKAGE[agent]
            pins = {native: request["nativeVersion"]} if request["nativeVersion"] is not None and native != package else None
            entry = release.agent_entry(bun, agent, version, pathlib.Path(workspace), registry=registry, pins=pins)
        except subprocess.TimeoutExpired as error:
            raise AgentInstallError(agent, version, "resolving its lockfile timed out") from error
        except ValueError as error:
            raise AgentInstallError(agent, version, str(error)) from error
    try:
        release.check_agent_entry(agent, entry)
    except ValueError as error:
        raise AgentInstallError(agent, version, str(error)) from error
    verify_requested_packages(request, entry["packages"])
    return entry


def installed_agent_packages(base, agent, version):
    """What an installed version folder holds, with sha512s: its own record, or the installed release's agents.json."""
    folder = base / "agents" / agent / version
    try:
        packages = json.loads(release.read_regular(folder / AGENT_PACKAGE_RECORD, AGENT_REQUEST_LIMIT * 16))
    except FileNotFoundError:
        packages = None
    except (OSError, ValueError) as error:
        raise AgentInstallError(agent, version, "its installed package record is unreadable") from error
    if packages is None:
        try:
            manifest = release.parse_agent_manifest(release.read_regular(base / "current/deploy/linux/agents.json", release.AGENT_MANIFEST_LIMIT))
        except (OSError, ValueError):
            manifest = None
        entry = manifest["agents"].get(agent) if manifest else None
        packages = entry["packages"] if entry and entry["version"] == version else None
    if packages is None:
        raise AgentInstallError(agent, version, "it is installed on this runner without a record of its integrity, so Paws cannot confirm it is the version it sent")
    if not isinstance(packages, list) or not all(isinstance(item, dict) and {"name", "version", "integrity"} <= set(item) for item in packages):
        raise AgentInstallError(agent, version, "its installed package record is unreadable")
    return packages


def apply_agent_request(request, state, bun, base, registry, save):
    """Install the requested version beside the others, then point current at it once no session holds the old one."""
    agent, version = request["agent"], request["version"]
    folder = base / "agents" / agent
    earlier = state.get("request") or {}
    # A request already waiting for sessions stays "waiting" between checks.
    outcome = {"id": request["id"], "version": version, "status": "waiting" if earlier.get("id") == request["id"] and earlier.get("status") == "waiting" else "installing"}
    if earlier.get("sessions") is not None and outcome["status"] == "waiting":
        outcome["sessions"] = earlier["sessions"]
    state["request"] = outcome
    if outcome["status"] == "installing":
        save()
    try:
        if (folder / version).is_dir() and not (folder / version).is_symlink():
            # An installed folder is never changed, so it must already hold the bytes Paws sent.
            verify_requested_packages(request, installed_agent_packages(base, agent, version))
        else:
            install_agent_version(agent, resolve_requested_agent(request, bun, registry), bun, base, registry)
        before = current_agent_version(folder)
        if switch_current(folder, version) == "waiting":
            outcome.update(status="waiting", sessions=holders(folder / before))
        else:
            outcome.pop("sessions", None)
            outcome["status"] = "installed"
    except (ValueError, OSError) as error:
        outcome.clear()
        outcome.update(id=request["id"], version=version, status="failed", error=" ".join(str(error).split())[:500] or "The install failed.")
    save()
    return outcome["status"]


def process_agent_requests(bun, base=BASE, registry=DEFAULT_REGISTRY, requests=AGENT_REQUESTS, status_path=AGENT_STATUS, sleep=time.sleep):
    """Apply what the runner forwarded from Paws. While a session holds an old version, check again every few seconds.

    A request is applied once: a finished or failed request id is not retried until Paws sends a new one.
    Requests the runner withdraws stop waiting; the version folder they installed stays.
    """
    status = read_agent_status(status_path)
    for agent in release.AGENT_PACKAGES:
        current = current_agent_version(base / "agents" / agent)
        entry = status["agents"].setdefault(agent, {"request": None})
        # Older installers kept the version before the last switch; nothing reads it any more.
        entry.pop("previous", None)
        entry["current"] = current
    save = lambda: write_atomic(status_path, json.dumps(status, sort_keys=True).encode(), 0o644)
    while True:
        try:
            pending = read_agent_requests(requests)
        except (OSError, ValueError) as error:
            print(json.dumps({"event": "agent_requests_invalid", "message": str(error)[:200]}), file=sys.stderr)
            pending = []
        waiting = False
        lock = lock_agents()
        try:
            for request in pending:
                state = status["agents"][request["agent"]]
                done = state.get("request")
                if done and done.get("id") == request["id"] and done.get("status") in ("installed", "failed"):
                    continue
                if apply_agent_request(request, state, bun, base, registry, save) == "waiting":
                    waiting = True
            for agent in release.AGENT_PACKAGES:
                status["agents"][agent]["current"] = current_agent_version(base / "agents" / agent)
            save()
        finally:
            os.close(lock)
        if not waiting:
            return status
        sleep(AGENT_POLL_SECONDS)


def main():
    if sys.argv[1:] == ["agents"]:
        print(json.dumps({"agents": agents_from_current()}))
        return
    if sys.argv[1:] == ["agent-requests"]:
        prerequisites()
        print(json.dumps(process_agent_requests(BASE / "bin/bun")))
        return
    parser = argparse.ArgumentParser()
    for name in ("manifest", "signature", "artifact", "release-key"):
        parser.add_argument("--" + name, required=True)
    arguments = parser.parse_args()
    docker = docker_access_choice()
    with tempfile.TemporaryDirectory(prefix="paws-release-") as temporary:
        manifest, artifact, fingerprint = release.verify_release(arguments, pathlib.Path(temporary))
        prerequisites()
        agents = prepare_agents(artifact)
        installed = install(manifest, artifact, fingerprint)
        installed["agents"] = finish_agents(agents)
        # The installer leaves the runner service stopped, so it starts without a removed docker group.
        installed["docker"] = configure_docker_access(docker)
        print(json.dumps(installed))


if __name__ == "__main__":
    main()
