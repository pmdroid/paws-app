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


def run(arguments, success=True):
    result = subprocess.run(arguments, env=installer.release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
    if (result.returncode == 0) != success:
        raise RuntimeError(result.stderr.decode())
    return result.stdout.decode()


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
        def install(success=True, trust=key):
            return run(["/usr/bin/python3", str(ROOT / "install.py"), "--artifact", str(artifact), "--manifest", str(manifest), "--signature", str(signature), "--release-key", str(trust)], success)
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
        if not runner_path.is_symlink() or os.readlink(runner_path) != "../current/bin/paws-runner" or runner_path.read_bytes()[:4] != b"\x7fELF":
            raise RuntimeError("Compiled runner is not installed")
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
            for provider in ("claude", "codex"):
                pointer = pathlib.Path("/opt/paws-runner/bin") / provider
                if os.readlink(pointer) != "../current/node_modules/.bin/" + provider or not pointer.is_file():
                    raise RuntimeError("Interrupted installation did not recover bundled provider pointers")
            interrupted.append(stage)
        def agent_identity():
            os.setgroups(os.getgrouplist(agent.pw_name, agent.pw_gid))
            os.setgid(agent.pw_gid)
            os.setuid(agent.pw_uid)
        accessible = subprocess.run(["/usr/bin/python3", "-I", "-c", "from pathlib import Path;assert Path('/opt/paws-runner/current/src/index.ts').read_bytes();assert Path('/opt/paws-runner/current/node_modules/.bin/claude-agent-acp').read_bytes()"], preexec_fn=agent_identity, capture_output=True, check=False)
        if accessible.returncode != 0:
            raise RuntimeError("Private installer umask prevented service UID package access")
        final = json.loads(state_path.read_bytes())
        if final["version"] != "0.1.6" or final["status"] != "installed":
            raise RuntimeError("Exact interrupted installation did not recover")
        for name in ("paws-agent@.service", "paws-runner.service"):
            path = pathlib.Path("/etc/systemd/system") / name
            if path.stat().st_uid != 0 or path.stat().st_mode & 0o7777 != 0o644:
                raise RuntimeError("Fixed unit has unsafe ownership or mode")
        for name in ("claude-agent-acp", "codex-acp", "grok"):
            path = pathlib.Path("/opt/paws-runner/current/node_modules/.bin") / name
            content = path.read_text()
            if path.is_symlink() or "exec /opt/paws-runner/bin/bun --no-env-file '/opt/paws-runner/current/node_modules/" not in content:
                raise RuntimeError("Adapter launcher does not preserve its trusted package path")
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
        for provider in ("claude", "codex"):
            pointer = pathlib.Path("/opt/paws-runner/bin") / provider
            pointer.unlink()
            pointer.symlink_to("../releases/0.1.1/node_modules/.bin/" + provider)
            install(False)
            if state_path.read_bytes() != installed_state:
                raise RuntimeError("Rejected provider pointer changed release trust state")
            pointer.unlink()
            pointer.symlink_to("../current/node_modules/.bin/" + provider)
        commands = [json.loads(line) for line in (ROOT / "systemctl-commands.jsonl").read_text().splitlines()]
        if any(command[0] == "start" for command in commands):
            raise RuntimeError("Installer started an unconfigured daemon")
        observations = {"verified": True, "artifactSha256": source["artifactSha256"], "unsignedRejected": True, "signedWrongRuntimeRejected": True, "wrongRuntimeTrustUnchanged": True, "wrongRuntimeCurrentInodesPreserved": True, "wrongRuntimeServicesNotStopped": True, "missingFlockRejected": True, "wrongKeyRejected": True, "manifestTamperRejected": True, "olderAndEqualVersionsRejected": True, "activeWorkerUpdateRejected": True, "activeCheckAndWitnessUpdatesRejected": True, "privateGroupAliasRejected": True, "unrelatedPrivilegedGroupRejected": True, "exactInterruptedRecovery": True, "newerReleaseDuringPendingRejected": True, "selectedPendingTreePreserved": True, "changedSelectedTreeRejected": True, "actualSigkillRecoveryCheckpoints": interrupted, "selectedRuntimePreservedBeforePointer": True, "sameVersionDifferentRuntimeBytes": True, "runtimeSelectedThroughCurrent": True, "danglingCurrentInitialized": True, "changedRuntimePointerRejected": True, "bundledProviderPointersRecovered": True, "changedProviderPointersRejected": True, "originalArtifactSha256": json.loads((ROOT / "package/manifest.json").read_bytes())["artifactSha256"], "originalRuntimeSha256": previous_runtime_sha, "candidateRuntimeSha256": candidate_runtime_sha, "privateUmaskServicePackageReadable": True, "changedPendingDigestRejected": True, "changedTrustedKeyRejected": True, "actualSysusersAndTmpfiles": True, "runnerUid": runner.pw_uid, "agentUid": agent.pw_uid, "resultsGid": grp.getgrnam("paws-results").gr_gid, "fixedUnitsInstalled": True, "adapterLaunchersRegular": True, "systemctlBackend": "recording fixture", "daemonStarted": False, "trustStateMode": oct(state_path.stat().st_mode & 0o7777)}
        print(json.dumps(observations))


if __name__ == "__main__":
    main()
