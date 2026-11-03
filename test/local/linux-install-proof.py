import hashlib
import io
import importlib.util
import json
import os
import pathlib
import pwd
import grp
import shutil
import signal
import time
import subprocess
import tempfile
import tarfile


ROOT = pathlib.Path("/proof")
spec = importlib.util.spec_from_file_location("paws_install", ROOT / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def run(arguments, success=True, env=None):
    result = subprocess.run(arguments, env={**installer.release.COMMAND_ENV, **(env or {})}, stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
    if (result.returncode == 0) != success:
        raise RuntimeError(result.stderr.decode())
    return result.stdout.decode()


DOCKER_ENGINE = """import json,os,socket,sys
path=sys.argv[1]
server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
server.bind(path)
os.chown(path,0,int(sys.argv[2]))
os.chmod(path,0o660)
server.listen(8)
open(sys.argv[3],"w").close()
body=json.dumps({"Platform":{"Name":"Docker Engine - Community"},"Components":[{"Name":"Engine","Version":"29.2.1"}],"Version":"29.2.1"}).encode()
while True:
    connection,_=server.accept()
    try:
        connection.settimeout(5)
        request=b""
        while b"\\r\\n\\r\\n" not in request:
            chunk=connection.recv(4096)
            if not chunk: break
            request+=chunk
        if request.split(b" ",2)[1:2]==[b"/version"]:
            connection.sendall(b"HTTP/1.0 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: "+str(len(body)).encode()+b"\\r\\n\\r\\n"+body)
        else:
            connection.sendall(b"HTTP/1.0 404 Not Found\\r\\nContent-Length: 0\\r\\n\\r\\n")
    except OSError:
        pass
    finally:
        connection.close()
"""


def start_docker_engine(gid):
    """A stand-in for a local rootful Docker Engine: root owns its socket, the given group may use it, and it answers /version."""
    socket_path = installer.DOCKER_SOCKET
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    socket_path.unlink(missing_ok=True)
    ready = ROOT / "docker-engine-ready"
    ready.unlink(missing_ok=True)
    engine = subprocess.Popen(["/usr/bin/python3", "-I", "-B", "-c", DOCKER_ENGINE, str(socket_path), str(gid), str(ready)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 30
    while not ready.exists():
        if engine.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError("Fake Docker Engine did not start")
        time.sleep(0.01)
    return engine


def stop_docker_engine(engine):
    engine.kill()
    engine.wait(timeout=10)


def docker_group_members():
    return [name for name in grp.getgrnam("docker").gr_mem]


def add_docker_group():
    if not pathlib.Path("/usr/sbin/usermod").is_file():
        raise RuntimeError("The proof image needs usermod at /usr/sbin/usermod")
    gid = max(group.gr_gid for group in grp.getgrall()) + 1
    with open("/etc/group", "a") as groups:
        groups.write(f"docker:x:{gid}:\n")
    return gid


def runner_work_reaches_docker():
    """Runner work as the daemon launches it: paws-runner, the worker environment, and a child spawned like workerLaunch."""
    script = ROOT / "docker-worker.ts"
    script.write_text("""const query = 'const response = await fetch("http://docker/version", { unix: "/var/run/docker.sock" }); const body = await response.json(); console.log(JSON.stringify({ status: response.status, components: body.Components.map((item) => item.Name), uid: process.getuid(), groups: (await Bun.file("/proc/self/status").text()).match(/^Groups:(.*)$/m)[1].trim().split(" ").map(Number) }));';
const child = Bun.spawn([process.execPath, "--no-env-file", "-e", query], { cwd: process.env.HOME, env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
process.stdout.write(code === 0 ? stdout : JSON.stringify({ error: stderr.slice(-400) }) + "\\n");
""")
    script.chmod(0o644)
    result = installer.as_runner(["/opt/paws-runner/bin/bun", "--no-env-file", str(script)], timeout=60)
    if result is None or result.returncode != 0:
        raise RuntimeError("Runner work could not run: " + ("timed out" if result is None else result.stderr.decode()[-400:]))
    return json.loads(result.stdout)


def provision_tools():
    loaders = list((ROOT / "host-runtime").glob("ld-linux-*.so.*"))
    if len(loaders) != 1:
        raise RuntimeError("Expected one native Linux dynamic loader")
    loader = loaders[0]
    for name in ("systemd-sysusers", "systemd-tmpfiles"):
        path = pathlib.Path("/usr/bin") / name
        path.write_text(f"#!/bin/sh\nexec {loader} --library-path {ROOT}/host-runtime {ROOT}/host-runtime/{name} \"$@\"\n")
        path.chmod(0o755)
    path = pathlib.Path("/usr/bin/systemctl")
    path.write_text("#!/bin/sh\nexec /usr/bin/python3 /proof/systemctl-fixture.py \"$@\"\n")
    path.chmod(0o755)
    (ROOT / "systemctl-fixture.py").write_text('''import json,pathlib,subprocess,sys
args=sys.argv[1:]
with open("/proof/systemctl-commands.jsonl","a") as log: log.write(json.dumps(args)+"\\n")
if args==["--version"]:
 loader=next(pathlib.Path("/proof/host-runtime").glob("ld-linux-*.so.*"))
 subprocess.run([str(loader),"--library-path","/proof/host-runtime","/proof/host-runtime/systemctl","--version"],check=True)
elif args[0]=="list-unit-files":
 names=args[3:] or [path.name for path in pathlib.Path("/etc/systemd/system").iterdir() if path.is_file()]
 present=[name for name in names if pathlib.Path("/etc/systemd/system",name).exists()]
 for name in present: print(name,"disabled")
 if args[3:] and not present: sys.exit(1)
elif args[0]=="list-units" and pathlib.Path("/proof/active-worker").exists(): print(pathlib.Path("/proof/active-worker").read_text()+" loaded active running")
elif args[0] not in ("list-units","stop","daemon-reload","enable","disable"): sys.exit(1)
''')


def docker_access_proof(install, sign, state_path):
    runner = pwd.getpwnam("paws-runner")
    absent = installer.docker_access("grant")
    if absent["status"] != ("no-engine" if shutil.which("docker", path=installer.WORKER_PATH) else "absent") or absent["changed"]:
        raise RuntimeError(f"A host without Docker Engine was not a no-op: {absent}")
    engine = start_docker_engine(0)
    try:
        if installer.docker_access("grant")["status"] != "missing-group":
            raise RuntimeError("A socket without a docker group was not diagnosed")
        gid = add_docker_group()
        os.chown(installer.DOCKER_SOCKET, 0, gid)
        for choice, status in ((None, "opt-in-required"), ("deny", "declined")):
            report = installer.docker_access(choice)
            if report["status"] != status or report["changed"] or docker_group_members():
                raise RuntimeError(f"Docker access without opt-in changed membership: {report}")
        denied = runner_work_reaches_docker()
        if "components" in denied:
            raise RuntimeError("Runner work reached Docker before it was granted access")
        before = set(os.getgrouplist("paws-runner", runner.pw_gid))
        sign("0.1.7")
        granted = json.loads(install(env={"PAWS_RUNNER_DOCKER_ACCESS": "grant"}))
        if granted["docker"]["status"] != "granted" or not granted["docker"]["changed"]:
            raise RuntimeError(f"Opt-in did not grant Docker access: {granted['docker']}")
        if docker_group_members() != ["paws-runner"] or set(os.getgrouplist("paws-runner", runner.pw_gid)) != before | {gid}:
            raise RuntimeError("Docker access did not append exactly the docker group to paws-runner")
        if gid in os.getgrouplist("paws-agent", pwd.getpwnam("paws-agent").pw_gid):
            raise RuntimeError("Docker access reached paws-agent")
        work = runner_work_reaches_docker()
        if work.get("status") != 200 or work.get("components") != ["Engine"] or work.get("uid") != runner.pw_uid or gid not in work.get("groups", []):
            raise RuntimeError(f"New runner work could not query the daemon: {work}")
        sign("0.1.8")
        again = json.loads(install(env={"PAWS_RUNNER_DOCKER_ACCESS": "grant"}))
        if again["docker"]["status"] != "ready" or again["docker"]["changed"] or docker_group_members() != ["paws-runner"]:
            raise RuntimeError(f"A second install changed Docker access: {again['docker']}")
        sign("0.1.9")
        upgraded = json.loads(install())
        if upgraded["docker"]["status"] != "ready":
            raise RuntimeError("An upgrade without a choice did not accept the granted membership")
        group_path = pathlib.Path("/etc/group")
        original_groups = group_path.read_text()
        installed = state_path.read_bytes()
        group_path.write_text(original_groups + f"paws-proof-docker-alias:x:{gid}:\n")
        try:
            sign("0.1.10")
            install(False)
            if state_path.read_bytes() != installed:
                raise RuntimeError("A docker group alias changed installed trust state")
        finally:
            group_path.write_text(original_groups)
    finally:
        stop_docker_engine(engine)
    if installer.docker_access(None)["status"] != "daemon-unavailable":
        raise RuntimeError("A stopped daemon was not reported apart from a permission failure")
    installer.DOCKER_SOCKET.unlink()
    return {"absentNoOp": True, "missingGroupDiagnosed": True, "optInRequiredAndDeclined": True, "grantedAppendsOnlyDocker": True, "newRunnerWorkQueriesDaemon": work, "secondInstallIdempotent": True, "upgradeAcceptsMembership": True, "dockerAliasRejected": True, "stoppedDaemonReported": True}


def main():
    if os.getuid() != 0 or pathlib.Path("/opt/paws-runner").exists():
        raise RuntimeError("Use a fresh disposable root namespace")
    provision_tools()
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="paws-release-install-") as temporary:
        root = pathlib.Path(temporary)
        private = root / "signing.pem"
        key = root / "release.pub"
        manifest = root / "manifest.json"
        signature = root / "manifest.sig"
        source = json.loads((ROOT / "package/manifest.json").read_bytes())
        artifact = ROOT / "package/artifact.tar"
        run(["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519", "-out", str(private)])
        run(["/usr/bin/openssl", "pkey", "-in", str(private), "-pubout", "-out", str(key)])
        def sign(version):
            manifest.write_text(json.dumps({**source, "version": version}))
            run(["/usr/bin/openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(private), "-in", str(manifest), "-out", str(signature)])
        def install(success=True, trust=key, env=None):
            return run(["/usr/bin/python3", str(ROOT / "install.py"), "--artifact", str(artifact), "--manifest", str(manifest), "--signature", str(signature), "--release-key", str(trust)], success, env)
        sign("0.1.1")
        signature.write_bytes(b"")
        install(False)
        if pathlib.Path("/opt/paws-runner").exists():
            raise RuntimeError("Unsigned release mutated installation")
        sign("0.1.1")
        wrong = root / "wrong.pem"
        wrong_key = root / "wrong.pub"
        run(["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519", "-out", str(wrong)])
        run(["/usr/bin/openssl", "pkey", "-in", str(wrong), "-pubout", "-out", str(wrong_key)])
        install(False, wrong_key)
        manifest.write_bytes(manifest.read_bytes() + b" ")
        install(False)
        sign("0.1.1")
        flock = pathlib.Path("/usr/bin/flock")
        hidden_flock = pathlib.Path("/usr/bin/paws-proof-flock")
        flock.rename(hidden_flock)
        try:
            install(False)
            if pathlib.Path("/var/lib/paws-runner-install").exists():
                raise RuntimeError("Missing flock changed installation state")
        finally:
            hidden_flock.rename(flock)
        initial_base = pathlib.Path("/opt/paws-runner")
        initial_base.mkdir(mode=0o755)
        (initial_base / "releases").mkdir(mode=0o755)
        (initial_base / "current").symlink_to(initial_base / "releases/0.1.1")
        first = json.loads(install())
        if not first["installed"]:
            raise RuntimeError("Valid release did not install")
        runner = pwd.getpwnam("paws-runner")
        agent = pwd.getpwnam("paws-agent")
        if runner.pw_uid == agent.pw_uid or runner.pw_uid == 0 or agent.pw_uid == 0:
            raise RuntimeError("Dedicated service identities are missing")
        if pathlib.Path("/opt/paws-runner/current").resolve() != pathlib.Path("/opt/paws-runner/releases/0.1.1"):
            raise RuntimeError("Fixed release pointer is incorrect")
        if run(["/opt/paws-runner/bin/bun", "--version"]).strip() != "1.4.2":
            raise RuntimeError("Pinned installed runtime failed")
        runner_path = pathlib.Path("/opt/paws-runner/bin/paws-runner")
        if not runner_path.is_symlink() or os.readlink(runner_path) != "../current/bin/paws-runner" or runner_path.read_bytes() != installer.release.RUNNER_LAUNCHER:
            raise RuntimeError("Runner launcher is not installed")
        launched = subprocess.run([str(runner_path), "runner", "unknown"], env=installer.release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
        if launched.returncode != 1 or launched.stderr.decode().strip() != "Runner command failed. Check the service identity, configuration and enrollment.":
            raise RuntimeError("Runner launcher did not start the runner: " + launched.stderr.decode()[-400:])
        state_path = pathlib.Path("/var/lib/paws-runner-install/release.json")
        installed = state_path.read_bytes()
        current_pointer = pathlib.Path("/opt/paws-runner/current")
        selected_release = current_pointer.resolve(strict=True)
        current_inode = current_pointer.lstat().st_ino
        selected_inode = selected_release.stat().st_ino
        runtime_inode = pathlib.Path("/opt/paws-runner/bin/bun").lstat().st_ino
        original_artifact, original_source = artifact, source
        wrong_runtime = root / "wrong-runtime.tar"
        with tarfile.open(artifact, "r:") as incoming, tarfile.open(wrong_runtime, "w", format=tarfile.USTAR_FORMAT) as outgoing:
            for member in incoming:
                content = incoming.extractfile(member)
                if member.name == "bin/bun":
                    binary = pathlib.Path("/usr/bin/python3").read_bytes()
                    member.size = len(binary)
                    outgoing.addfile(member, io.BytesIO(binary))
                else:
                    outgoing.addfile(member, content)
        with wrong_runtime.open("rb") as stream:
            wrong_digest = hashlib.file_digest(stream, "sha256").hexdigest()
        artifact = wrong_runtime
        source = {**source, "artifactSha256": wrong_digest}
        sign("0.1.2")
        commands_path = ROOT / "systemctl-commands.jsonl"
        previous_commands = len(commands_path.read_text().splitlines())
        rejected = subprocess.run(["/usr/bin/python3", str(ROOT / "install.py"), "--artifact", str(artifact), "--manifest", str(manifest), "--signature", str(signature), "--release-key", str(key)], env=installer.release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
        if rejected.returncode == 0 or b"Packaged Bun does not match the pinned runtime" not in rejected.stderr:
            raise RuntimeError("Signed wrong-runtime fixture did not reach pinned Bun validation")
        new_commands = [json.loads(line) for line in commands_path.read_text().splitlines()[previous_commands:]]
        wrong_runtime_observations = {"signedWrongRuntimeRejected": True, "installedTrustUnchanged": state_path.read_bytes() == installed, "currentPointerInodePreserved": current_pointer.lstat().st_ino == current_inode, "selectedReleaseInodePreserved": selected_release.stat().st_ino == selected_inode, "runtimePointerInodePreserved": pathlib.Path("/opt/paws-runner/bin/bun").lstat().st_ino == runtime_inode, "installedStatus": json.loads(state_path.read_bytes())["status"], "servicesNotStopped": not any(command[0] == "stop" for command in new_commands), "wrongRuntimeArtifactSha256": wrong_digest}
        (ROOT / "wrong-runtime-observations.json").write_text(json.dumps(wrong_runtime_observations))
        if not all(wrong_runtime_observations[name] for name in ("installedTrustUnchanged", "currentPointerInodePreserved", "selectedReleaseInodePreserved", "runtimePointerInodePreserved", "servicesNotStopped")):
            raise RuntimeError("Signed wrong runtime changed installed trust, release pointers or running services")
        artifact, source = original_artifact, original_source
        group_path = pathlib.Path("/etc/group")
        original_groups = group_path.read_text()
        input_gid = grp.getgrnam("paws-runner").gr_gid
        group_path.write_text(original_groups + "paws-proof-input-alias:x:" + str(input_gid) + ":paws-agent\n")
        try:
            if input_gid not in os.getgrouplist("paws-agent", agent.pw_gid):
                raise RuntimeError("Group alias fixture did not grant private input membership")
            sign("0.1.2")
            install(False)
            if state_path.read_bytes() != installed:
                raise RuntimeError("Rejected private-group alias changed installed trust state")
        finally:
            group_path.write_text(original_groups)
        unrelated_gid = max(group.gr_gid for group in grp.getgrall()) + 1
        group_path.write_text(original_groups + "paws-proof-privileged:x:" + str(unrelated_gid) + ":paws-agent\n")
        try:
            if unrelated_gid not in os.getgrouplist("paws-agent", agent.pw_gid):
                raise RuntimeError("Unrelated supplemental-group fixture did not take effect")
            install(False)
            if state_path.read_bytes() != installed:
                raise RuntimeError("Rejected privileged supplemental group changed installed trust state")
        finally:
            group_path.write_text(original_groups)
        for version in ("0.1.0", "0.1.1"):
            sign(version)
            install(False)
            if state_path.read_bytes() != installed:
                raise RuntimeError("Rejected replay changed monotonic state")
        sign("0.1.2")
        run(["/usr/bin/openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(wrong), "-in", str(manifest), "-out", str(signature)])
        install(False, wrong_key)
        if state_path.read_bytes() != installed:
            raise RuntimeError("New signing key changed pinned trust state")
        sign("0.1.2")
        for template in ("paws-agent", "paws-check", "paws-check-witness"):
            (ROOT / "active-worker").write_text(template + "@01K00000000000000000000000.service")
            commands_path = ROOT / "systemctl-commands.jsonl"
            previous_commands = len(commands_path.read_text().splitlines())
            install(False)
            new_commands = [json.loads(line) for line in commands_path.read_text().splitlines()[previous_commands:]]
            if any(command[0] == "stop" for command in new_commands):
                raise RuntimeError("Refused active execution update stopped its broker")
            (ROOT / "active-worker").unlink()
            if state_path.read_bytes() != installed:
                raise RuntimeError("Active execution update changed monotonic state")
        previous = json.loads(installed)
        state_path.write_text(json.dumps({**previous, "version": "0.1.2", "status": "pending", "artifactSha256": "0" * 64}))
        install(False)
        state_path.write_text(json.dumps({**previous, "version": "0.1.2", "status": "pending"}))
        recovered = json.loads(install())
        if recovered["version"] != "0.1.2" or recovered["installed"] is not True:
            raise RuntimeError("Update did not recover the pending release")
        previous_runtime_sha = hashlib.sha256(pathlib.Path("/opt/paws-runner/bin/bun").read_bytes()).hexdigest()
        candidate = root / "candidate.tar"
        with tarfile.open(artifact, "r:") as incoming, tarfile.open(candidate, "w", format=tarfile.USTAR_FORMAT) as outgoing:
            for member in incoming:
                content = incoming.extractfile(member)
                if member.name == "bin/bun":
                    binary = content.read() + b"paws-runtime-crash-proof\n"
                    member.size = len(binary)
                    outgoing.addfile(member, io.BytesIO(binary))
                else:
                    outgoing.addfile(member, content)
        artifact = candidate
        source = {**source, "artifactSha256": hashlib.sha256(candidate.read_bytes()).hexdigest()}
        candidate_runtime_sha = hashlib.sha256(binary).hexdigest()
        if candidate_runtime_sha == previous_runtime_sha:
            raise RuntimeError("Runtime replacement proof did not change bytes")
        interrupt_script = ROOT / "interrupt-install.py"
        interrupt_script.write_text('''import importlib.util,json,os,pathlib,signal,sys
spec=importlib.util.spec_from_file_location("interrupted_install","/proof/install.py")
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
stage=sys.argv[1]
sys.argv=["/proof/install.py",*sys.argv[2:]]
def pause():
 pathlib.Path("/proof/installer-paused").write_text(stage)
 os.kill(os.getpid(),signal.SIGSTOP)
atomic=module.write_atomic
rename=module.os.rename
replace=module.os.replace
def write_atomic(path,content,mode):
 atomic(path,content,mode)
 if stage=="pending" and path==module.STATE/"release.json" and json.loads(content)["status"]=="pending": pause()
 if stage=="runtime" and path.name=="bun": pause()
def rename_release(source,destination,*args,**kwargs):
 rename(source,destination,*args,**kwargs)
 if stage=="release" and pathlib.Path(destination).parent==module.BASE/"releases": pause()
def replace_current(source,destination,*args,**kwargs):
 replace(source,destination,*args,**kwargs)
 if stage=="current" and destination==module.BASE/"current": pause()
module.write_atomic=write_atomic
module.os.rename=rename_release
module.os.replace=replace_current
module.main()
''')
        interrupted = []
        for number, stage in enumerate(("runtime", "pending", "release", "current"), 3):
            version = "0.1." + str(number)
            previous_current = pathlib.Path("/opt/paws-runner/current").resolve(strict=True)
            previous_runtime = hashlib.sha256(pathlib.Path("/opt/paws-runner/bin/bun").read_bytes()).hexdigest()
            sign(version)
            marker = ROOT / "installer-paused"
            marker.unlink(missing_ok=True)
            process = subprocess.Popen(["/usr/bin/python3", "-I", "-B", str(interrupt_script), stage, "--artifact", str(artifact), "--manifest", str(manifest), "--signature", str(signature), "--release-key", str(key)], env=installer.release.COMMAND_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                deadline = time.monotonic() + 90
                while not marker.exists():
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Installer did not reach interruption checkpoint " + stage)
                    time.sleep(0.01)
                os.killpg(process.pid, signal.SIGKILL)
                output, error = process.communicate(timeout=10)
                if process.returncode != -signal.SIGKILL:
                    raise RuntimeError("Installer interruption was not an actual SIGKILL")
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.communicate(timeout=10)
            active_runtime = hashlib.sha256(pathlib.Path("/opt/paws-runner/bin/bun").read_bytes()).hexdigest()
            if stage != "current" and active_runtime != previous_runtime:
                raise RuntimeError("Interrupted installation replaced the selected release runtime before its pointer")
            pending = json.loads(state_path.read_bytes())
            if pending["status"] != "pending" or pending["version"] != version or pending["artifactSha256"] != source["artifactSha256"] or not (previous_current / "src/index.ts").is_file():
                raise RuntimeError("Interrupted installation lost its exact recovery identity or previous release")
            pending_bytes = state_path.read_bytes()
            selected = pathlib.Path("/opt/paws-runner/current").resolve(strict=True)
            selected_inode = selected.stat().st_ino
            sign("0.2.0")
            install(False)
            if state_path.read_bytes() != pending_bytes or selected.stat().st_ino != selected_inode:
                raise RuntimeError("Different release replaced an exact pending recovery")
            sign(version)
            if stage == "current":
                selected_file = selected / "src/index.ts"
                original_content = selected_file.read_bytes()
                selected_file.write_bytes(original_content + b"\ninvalid-pending-proof\n")
                install(False)
                if state_path.read_bytes() != pending_bytes or selected.stat().st_ino != selected_inode or not selected_file.is_file():
                    raise RuntimeError("Rejected changed pending tree removed the selected release")
                selected_file.write_bytes(original_content)
            recovery = json.loads(install())
            if pathlib.Path("/opt/paws-runner/current").resolve(strict=True) != pathlib.Path("/opt/paws-runner/releases") / version:
                raise RuntimeError("Actual interrupted installation did not recover its exact release")
            if stage == "current" and selected.stat().st_ino != selected_inode:
                raise RuntimeError("Exact recovery replaced the selected release directory")
            for launcher in installer.release.PROVIDER_EXECUTABLES:
                pointer = pathlib.Path("/opt/paws-runner/bin") / launcher
                if pointer.is_symlink() or pointer.read_bytes() != installer.release.agent_launcher(launcher):
                    raise RuntimeError("Interrupted installation did not recover the agent launchers")
            interrupted.append(stage)
        def agent_identity():
            os.setgroups(os.getgrouplist(agent.pw_name, agent.pw_gid))
            os.setgid(agent.pw_gid)
            os.setuid(agent.pw_uid)
        accessible = subprocess.run(["/usr/bin/python3", "-I", "-c", "from pathlib import Path;assert Path('/opt/paws-runner/current/src/index.ts').read_bytes();assert Path('/opt/paws-runner/bin/claude-agent-acp').read_bytes();assert Path('/opt/paws-runner/agents/claude/current/package.json').read_bytes()"], preexec_fn=agent_identity, capture_output=True, check=False)
        if accessible.returncode != 0:
            raise RuntimeError("Private installer umask prevented service UID package access")
        final = json.loads(state_path.read_bytes())
        if final["version"] != "0.1.6" or final["status"] != "installed":
            raise RuntimeError("Exact interrupted installation did not recover")
        for name in ("paws-agent@.service", "paws-runner.service"):
            path = pathlib.Path("/etc/systemd/system") / name
            if path.stat().st_uid != 0 or path.stat().st_mode & 0o7777 != 0o644:
                raise RuntimeError("Fixed unit has unsafe ownership or mode")
        for name in installer.release.PROVIDER_EXECUTABLES:
            path = pathlib.Path("/opt/paws-runner/bin") / name
            if path.is_symlink() or path.stat().st_uid != 0 or path.stat().st_mode & 0o7777 != 0o755 or path.read_bytes() != installer.release.agent_launcher(name):
                raise RuntimeError("Agent launcher is not the fixed root-owned launcher")
            if (pathlib.Path("/opt/paws-runner/current/node_modules/.bin") / name).exists():
                raise RuntimeError("The release still carries a bundled agent")
        runtime_path = pathlib.Path("/opt/paws-runner/bin/bun")
        if not runtime_path.is_symlink() or os.readlink(runtime_path) != "../current/bin/bun" or hashlib.sha256(runtime_path.read_bytes()).hexdigest() != candidate_runtime_sha or run([str(runtime_path), "--version"]).strip() != "1.4.2":
            raise RuntimeError("Fixed runtime path does not select the verified release runtime")
        installed_state = state_path.read_bytes()
        runtime_path.unlink()
        runtime_path.symlink_to("../releases/0.1.1/bin/bun")
        sign("0.1.7")
        install(False)
        if state_path.read_bytes() != installed_state:
            raise RuntimeError("Rejected runtime pointer changed release trust state")
        runtime_path.unlink()
        runtime_path.symlink_to("../current/bin/bun")
        runner_path.unlink()
        runner_path.symlink_to("../releases/0.1.1/bin/paws-runner")
        install(False)
        if state_path.read_bytes() != installed_state:
            raise RuntimeError("Rejected runner pointer changed release trust state")
        runner_path.unlink()
        runner_path.symlink_to("../current/bin/paws-runner")
        docker = docker_access_proof(install, sign, state_path)
        commands = [json.loads(line) for line in (ROOT / "systemctl-commands.jsonl").read_text().splitlines()]
        if any(command[0] == "start" for command in commands):
            raise RuntimeError("Installer started an unconfigured daemon")
        observations = {"verified": True, "artifactSha256": source["artifactSha256"], "unsignedRejected": True, "signedWrongRuntimeRejected": True, "wrongRuntimeTrustUnchanged": True, "wrongRuntimeCurrentInodesPreserved": True, "wrongRuntimeServicesNotStopped": True, "missingFlockRejected": True, "wrongKeyRejected": True, "manifestTamperRejected": True, "olderAndEqualVersionsRejected": True, "activeWorkerUpdateRejected": True, "activeCheckAndWitnessUpdatesRejected": True, "privateGroupAliasRejected": True, "unrelatedPrivilegedGroupRejected": True, "exactInterruptedRecovery": True, "newerReleaseDuringPendingRejected": True, "selectedPendingTreePreserved": True, "changedSelectedTreeRejected": True, "actualSigkillRecoveryCheckpoints": interrupted, "selectedRuntimePreservedBeforePointer": True, "sameVersionDifferentRuntimeBytes": True, "runtimeSelectedThroughCurrent": True, "danglingCurrentInitialized": True, "changedRuntimePointerRejected": True, "agentLaunchersRecovered": True, "originalArtifactSha256": json.loads((ROOT / "package/manifest.json").read_bytes())["artifactSha256"], "originalRuntimeSha256": previous_runtime_sha, "candidateRuntimeSha256": candidate_runtime_sha, "privateUmaskServicePackageReadable": True, "changedPendingDigestRejected": True, "changedTrustedKeyRejected": True, "actualSysusersAndTmpfiles": True, "runnerUid": runner.pw_uid, "agentUid": agent.pw_uid, "resultsGid": grp.getgrnam("paws-results").gr_gid, "fixedUnitsInstalled": True, "adapterLaunchersRegular": True, "systemctlBackend": "recording fixture", "daemonStarted": False, "trustStateMode": oct(state_path.stat().st_mode & 0o7777), "dockerAccess": docker}
        print(json.dumps(observations))


if __name__ == "__main__":
    main()
