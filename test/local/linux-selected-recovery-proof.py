import hashlib
import importlib.util
import json
import os
import pathlib
import signal
import subprocess
import tempfile
import time


ROOT = pathlib.Path("/proof")
spec = importlib.util.spec_from_file_location("installation_fixture", ROOT / "source.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def main():
    if os.getuid() != 0 or pathlib.Path("/opt/paws-runner").exists():
        raise RuntimeError("Use a fresh disposable root namespace")
    fixture.provision_tools()
    with tempfile.TemporaryDirectory(prefix="selected-recovery-") as temporary:
        root = pathlib.Path(temporary)
        private = root / "signing.pem"
        key = root / "release.pub"
        manifest = root / "manifest.json"
        signature = root / "manifest.sig"
        source = json.loads((ROOT / "package/manifest.json").read_bytes())
        fixture.run(["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519", "-out", str(private)])
        fixture.run(["/usr/bin/openssl", "pkey", "-in", str(private), "-pubout", "-out", str(key)])

        def sign(version):
            manifest.write_text(json.dumps({**source, "version": version}))
            fixture.run(["/usr/bin/openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(private), "-in", str(manifest), "-out", str(signature)])

        arguments = ["--artifact", str(ROOT / "package/artifact.tar"), "--manifest", str(manifest), "--signature", str(signature), "--release-key", str(key)]
        sign("0.1.1")
        wrapper = ROOT / "selected-interrupt.py"
        wrapper.write_text('''import importlib.util,os,pathlib,signal,sys
spec=importlib.util.spec_from_file_location("interrupted_install","/proof/install.py")
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
stage=sys.argv[1]
sys.argv=["/proof/install.py",*sys.argv[2:]]
def pause():
 pathlib.Path("/proof/installer-paused").write_text(stage)
 os.kill(os.getpid(),signal.SIGSTOP)
replace=module.os.replace
rename=module.os.rename
mkstemp=module.tempfile.mkstemp
def replace_current(source,destination,*args,**kwargs):
 replace(source,destination,*args,**kwargs)
 if stage=="current" and destination==module.BASE/"current": pause()
def publish_release(source,destination,*args,**kwargs):
 rename(source,destination,*args,**kwargs)
 if stage=="release" and pathlib.Path(destination).parent==module.BASE/"releases": pause()
def selected_temporary(*args,**kwargs):
 result=mkstemp(*args,**kwargs)
 if stage=="selected-write" and pathlib.Path(kwargs["dir"])==module.BASE/"releases/0.1.2/deploy/linux": pause()
 return result
module.os.replace=replace_current
module.os.rename=publish_release
module.tempfile.mkstemp=selected_temporary
module.main()
''')

        def interrupt(stage):
            marker = ROOT / "installer-paused"
            marker.unlink(missing_ok=True)
            process = subprocess.Popen(["/usr/bin/python3", "-I", "-B", str(wrapper), stage, *arguments], env=fixture.installer.release.COMMAND_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                deadline = time.monotonic() + 90
                while not marker.exists() and process.poll() is None:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Selected recovery exceeded its bounded checkpoint")
                    time.sleep(0.01)
                stopped = marker.exists()
                if stopped:
                    os.killpg(process.pid, signal.SIGKILL)
                output, error = process.communicate(timeout=10)
                if stopped and process.returncode != -signal.SIGKILL:
                    raise RuntimeError("Installer interruption was not an actual SIGKILL")
                if not stopped and process.returncode != 0:
                    raise RuntimeError(error.decode())
                return stopped, output
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.communicate(timeout=10)

        base = pathlib.Path("/opt/paws-runner")
        (base / "releases").mkdir(parents=True, mode=0o755)
        (base / "current").symlink_to(base / "releases/0.1.1")
        stopped, _ = interrupt("release")
        if not stopped:
            raise RuntimeError("Installer did not reach dangling-pointer publication checkpoint")
        retried = subprocess.run(["/usr/bin/python3", str(ROOT / "install.py"), *arguments], env=fixture.installer.release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
        if retried.returncode != 0:
            print(json.dumps({"verified": False, "actualSigkillDanglingPublication": True, "exactRetryExit": retried.returncode, "exactRetryError": retried.stderr.decode(), "runtimePresent": (base / "current/bin/bun").is_file(), "deployedAssetsPresent": (base / "current/deploy/linux").is_dir()}))
            raise RuntimeError("Incomplete publication under dangling current blocked exact recovery")
        first = json.loads(retried.stdout)
        if not (base / "current/bin/bun").is_file():
            raise RuntimeError("Published release is missing its runtime")
        sign("0.1.2")
        stopped, _ = interrupt("current")
        if not stopped:
            raise RuntimeError("Installer did not reach the current-pointer checkpoint")
        selected = pathlib.Path("/opt/paws-runner/current").resolve(strict=True)
        state = pathlib.Path("/var/lib/paws-runner-install/release.json")
        pending = state.read_bytes()
        if json.loads(pending)["status"] != "pending":
            raise RuntimeError("Interruption did not preserve pending recovery")
        inode = selected.stat().st_ino
        deployed = selected / "deploy/linux"
        before = {path.name: {"inode": path.stat().st_ino, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in deployed.iterdir()}
        stopped, output = interrupt("selected-write")
        if stopped:
            failed = subprocess.run(["/usr/bin/python3", str(ROOT / "install.py"), *arguments], env=fixture.installer.release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
            print(json.dumps({"verified": False, "actualSigkill": True, "selectedTemporaryFiles": [path.name for path in deployed.glob(".paws-*")], "exactRetryExit": failed.returncode, "exactRetryError": failed.stderr.decode(), "pendingUnchanged": state.read_bytes() == pending, "selectedDirectoryInodePreserved": selected.stat().st_ino == inode}))
            raise RuntimeError("Selected recovery created a temporary file that blocks exact retry after SIGKILL")
        after = {path.name: {"inode": path.stat().st_ino, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in deployed.iterdir()}
        recovered = json.loads(output)
        if before != after or selected.stat().st_ino != inode or json.loads(state.read_bytes())["status"] != "installed" or recovered["verifierIdentity"] != first["verifierIdentity"]:
            raise RuntimeError("Selected recovery changed its already verified release or identity")
        print(json.dumps({"verified": True, "actualSigkillDanglingPublication": True, "actualSigkillCurrentCheckpoint": True, "exactSelectedRecoveryCompleted": True, "selectedFilesNotRewritten": True, "selectedAssetCount": len(before), "selectedDirectoryInodePreserved": True, "verifierIdentityPreserved": True, "artifactSha256": source["artifactSha256"], "systemctlBackend": "recording fixture", "daemonStarted": False}))


if __name__ == "__main__":
    main()
