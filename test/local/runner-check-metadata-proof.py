import hashlib
import ctypes
import json
import os
import pathlib
import subprocess
import sys
import shutil
import struct


if os.getuid() != 0:
    raise RuntimeError("Disposable root namespace required")
with open("/etc/passwd", "a") as stream:
    stream.write("paws-runner:x:1001:1001::/nonexistent:/usr/sbin/nologin\npaws-check:x:1005:1005::/nonexistent:/usr/sbin/nologin\n")
with open("/etc/group", "a") as stream:
    stream.write("paws-runner:x:1001:\npaws-check:x:1005:\npaws-check-input:x:1004:\npaws-check-metadata:x:1006:\n")
attempt = "01K00000000000000000000000"
private = pathlib.Path("/var/lib/paws-check-metadata")
work = pathlib.Path("/var/lib/paws-check-attempts")
inputs = pathlib.Path("/var/lib/paws-check-input")
for path, uid, gid, mode in ((private, 0, 1006, 0o750), (private / attempt, 0, 1006, 0o750), (private / attempt / "git", 1005, 1006, 0o770), (work, 0, 1005, 0o750), (work / attempt, 0, 1005, 0o750), (work / attempt / "workspace", 1005, 1005, 0o700), (inputs, 1001, 1004, 0o2750), (inputs / "attempts", 1001, 1004, 0o2750), (inputs / "attempts" / attempt, 1001, 1004, 0o750)):
    path.mkdir()
    os.chown(path, uid, gid)
    path.chmod(mode)
seed = pathlib.Path("/tmp/paws-metadata-seed")
seed.mkdir()


def git(*arguments):
    result = subprocess.run(["/usr/bin/git", *arguments], env={"PATH": "/usr/bin:/bin", "HOME": "/var/empty", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}, capture_output=True, text=True, check=True)
    return result.stdout.strip()


git("-C", str(seed), "init")
git("-C", str(seed), "config", "user.name", "Local verification")
git("-C", str(seed), "config", "user.email", "local@example.invalid")
(seed / "tracked.txt").write_text("candidate\n")
(seed / ".gitignore").write_text("node_modules/\n")
large_repository = len(sys.argv) == 3 and sys.argv[2] == "large"
if large_repository:
    for number in range(2000):
        (seed / ("tracked-long-name-" + str(number).zfill(5) + "-" + "x" * 50 + ".txt")).write_text("candidate\n")
submodule = pathlib.Path("/tmp/paws-metadata-submodule")
submodule.mkdir()
git("-C", str(submodule), "init")
git("-C", str(submodule), "config", "user.name", "Local verification")
git("-C", str(submodule), "config", "user.email", "local@example.invalid")
(submodule / "tracked.txt").write_text("submodule candidate\n")
git("-C", str(submodule), "add", ".")
git("-C", str(submodule), "commit", "-m", "Submodule fixture")
git("-c", "protocol.file.allow=always", "-C", str(seed), "submodule", "add", str(submodule), "dependency")
git("-C", str(seed), "add", ".")
git("-C", str(seed), "commit", "-m", "Candidate fixture")
candidate = git("-C", str(seed), "rev-parse", "HEAD")
(seed / "tracked.txt").write_text("different candidate\n")
git("-C", str(seed), "add", ".")
git("-C", str(seed), "commit", "-m", "Other fixture candidate")
other_candidate = git("-C", str(seed), "rev-parse", "HEAD")
bundle = inputs / "attempts" / attempt / "repository.bundle"
git("-C", str(seed), "bundle", "create", str(bundle), "HEAD")
identity = {"format": 1, "verificationAttemptId": attempt, "candidateSha": candidate, "bundleSha256": hashlib.sha256(bundle.read_bytes()).hexdigest()}
identity_path = bundle.parent / "attempt.json"
identity_path.write_text(json.dumps(identity))
for path in (bundle, identity_path):
    os.chown(path, 1001, 1004)
    path.chmod(0o640)


def run(arguments, trusted=True, success=True):
    def credentials():
        os.umask(0o077)
        class Header(ctypes.Structure):
            _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]
        class Data(ctypes.Structure):
            _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]
        values = (Data * 2)(Data(192, 192, 0), Data(0, 0, 0))
        if ctypes.CDLL(None, use_errno=True).capset(ctypes.byref(Header(0x20080522, 0)), ctypes.byref(values)) != 0:
            raise OSError(ctypes.get_errno(), "Cannot restrict metadata launcher capabilities")
        os.setgroups([1005, 1004] if trusted else [])
        os.setgid(1006 if trusted else 1005)
        os.setuid(1005)
    result = subprocess.run(arguments, preexec_fn=credentials, env={"PATH": "/usr/bin:/bin", "HOME": "/var/empty"}, capture_output=True, text=True, timeout=90, check=False)
    if (result.returncode == 0) != success:
        raise RuntimeError(result.stderr or "Unexpected metadata probe outcome")
    return json.loads(result.stdout) if success and sys.argv[1] in arguments else None


def inspect():
    return run(["/usr/bin/python3", "-I", "-B", sys.argv[1], "inspect", attempt, candidate])


identity_path.write_text(json.dumps({**identity, "candidateSha": other_candidate}))
run(["/usr/bin/python3", "-I", "-B", sys.argv[1], "init", attempt, candidate], success=False)
identity_path.write_text(json.dumps(identity))
def daemon_identity():
    os.setgroups([1004])
    os.setgid(1001)
    os.setuid(1001)


race = pathlib.Path("/tmp/paws-metadata-bundle-race")
race.mkdir(mode=0o777)
race.chmod(0o777)
wrapper = race / "observe-fetch.py"
wrapper.write_text("import importlib.util,pathlib,sys,time\nspec=importlib.util.spec_from_file_location('metadata',sys.argv[1])\nmodule=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\nsys.argv=sys.argv[1:]\noriginal=module.git\ndef git(arguments,*args,**kwargs):\n if 'fetch' in arguments and not pathlib.Path('" + str(race / "requested") + "').exists():\n  pathlib.Path('" + str(race / "requested") + "').touch()\n  deadline=time.monotonic()+10\n  while not pathlib.Path('" + str(race / "replaced") + "').exists():\n   if time.monotonic()>deadline: raise RuntimeError('Daemon bundle replacement timed out')\n   time.sleep(.01)\n return original(arguments,*args,**kwargs)\nmodule.git=git\nmodule.main()\n")
attacker = subprocess.Popen(["/usr/bin/python3", "-I", "-c", "import pathlib,time,os;root=pathlib.Path('" + str(race) + "');deadline=time.monotonic()+30\nwhile not (root/'requested').exists():\n if time.monotonic()>deadline: raise RuntimeError('Fetch observation timed out')\n time.sleep(.01)\nbundle=pathlib.Path('" + str(bundle) + "');bundle.rename(bundle.with_name('previous.bundle'));bundle.write_bytes(b'Invalid replacement bundle');bundle.chmod(0o640);(root/'replaced').touch()"], preexec_fn=daemon_identity, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
try:
    assert run(["/usr/bin/python3", "-I", "-B", str(wrapper), sys.argv[1], "init", attempt, candidate]) == {"status": "", "headMoved": False}
    stdout, stderr = attacker.communicate(timeout=10)
    assert attacker.returncode == 0, stderr.decode()
    assert bundle.read_bytes() == b"Invalid replacement bundle"
    assert hashlib.sha256((private / attempt / "git/repository.bundle").read_bytes()).hexdigest() == identity["bundleSha256"]
finally:
    if attacker.poll() is None:
        attacker.kill()
        attacker.communicate()
    previous = bundle.with_name("previous.bundle")
    if previous.exists():
        bundle.unlink()
        previous.rename(bundle)

for name in ("config", "repository.bundle"):
    for action in ("read_bytes()", "unlink()"):
        attack = subprocess.run(["/usr/bin/python3", "-c", "import pathlib; pathlib.Path('" + str(private / attempt / "git" / name) + "')." + action], preexec_fn=daemon_identity, capture_output=True, check=False)
        assert attack.returncode != 0, "Daemon accessed private Git metadata"

workspace = work / attempt / "workspace"
for path in (submodule, *submodule.rglob("*")):
    os.chown(path, 1005, 1005)
run(["/usr/bin/git", "-c", "protocol.file.allow=always", "clone", str(submodule), str(workspace / "dependency")], trusted=False)
assert inspect() == {"status": None, "headMoved": False}
status_marker = race / "status-invoked"
status_wrapper = race / "observe-status.py"
status_wrapper.write_text("import importlib.util,pathlib,sys\nspec=importlib.util.spec_from_file_location('metadata',sys.argv[1])\nmodule=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\nsys.argv=sys.argv[1:]\noriginal=module.git\ndef git(arguments,*args,**kwargs):\n if 'status' in arguments: pathlib.Path('" + str(status_marker) + "').touch()\n return original(arguments,*args,**kwargs)\nmodule.git=git\nmodule.main()\n")
assert run(["/usr/bin/python3", "-I", "-B", str(status_wrapper), sys.argv[1], "inspect", attempt, candidate]) == {"status": None, "headMoved": False}
assert not status_marker.exists()
with (workspace / "dependency/.git/config").open("a") as stream:
    stream.write("\n[core]\nfsmonitor = /usr/bin/touch /tmp/paws-submodule-monitor-ran\n")
(workspace / "dependency/tracked.txt").write_text("submodule changed\n")
assert inspect() == {"status": None, "headMoved": False}
assert not pathlib.Path("/tmp/paws-submodule-monitor-ran").exists()
shutil.rmtree(workspace / "dependency")
(workspace / "dependency").mkdir()
os.chown(workspace / "dependency", 1005, 1005)
assert inspect() == {"status": "", "headMoved": False}
run(["/usr/bin/git", "-C", str(workspace), "update-index", "--cacheinfo", "160000," + candidate + ",dependency"], trusted=False)
assert inspect() == {"status": None, "headMoved": False}
run(["/usr/bin/git", "-C", str(workspace), "reset", candidate, "--", "dependency"], trusted=False)
assert inspect() == {"status": "", "headMoved": False}
(workspace / "dependency").rmdir()
(workspace / "dependency").symlink_to(submodule, target_is_directory=True)
assert inspect() == {"status": None, "headMoved": False}
(workspace / "dependency").unlink()
assert inspect() == {"status": "", "headMoved": False}
status_wrapper.write_text("import importlib.util,pathlib,sys\nspec=importlib.util.spec_from_file_location('metadata',sys.argv[1])\nmodule=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\nsys.argv=sys.argv[1:]\noriginal=module.git\ndef git(arguments,*args,**kwargs):\n if 'status' in arguments:\n  assert '--ignore-submodules=all' in arguments\n  path=pathlib.Path('" + str(workspace / "dependency") + "');path.mkdir();(path/'populated').touch()\n return original(arguments,*args,**kwargs)\nmodule.git=git\nmodule.main()\n")
assert run(["/usr/bin/python3", "-I", "-B", str(status_wrapper), sys.argv[1], "inspect", attempt, candidate]) == {"status": None, "headMoved": False}
shutil.rmtree(workspace / "dependency")
assert inspect() == {"status": "", "headMoved": False}
index_path = workspace / ".git/index"
original_index = index_path.read_bytes()
(workspace / "tracked.txt").write_text("tampered!\n")
os.utime(workspace / "tracked.txt", (1_000_000_000, 1_000_000_000))
forged_index = bytearray(original_index)
assert forged_index[:4] == b"DIRC" and struct.unpack_from(">I", forged_index, 4)[0] == 2
offset = 12
for _ in range(struct.unpack_from(">I", forged_index, 8)[0]):
    end = forged_index.index(0, offset + 62)
    path = forged_index[offset + 62:end]
    if path == b"tracked.txt":
        info = (workspace / "tracked.txt").stat()
        values = (info.st_ctime_ns // 1_000_000_000, info.st_ctime_ns % 1_000_000_000, info.st_mtime_ns // 1_000_000_000, info.st_mtime_ns % 1_000_000_000, info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size)
        struct.pack_into(">10I", forged_index, offset, *(value & 0xffffffff for value in values))
    offset += ((end - offset + 1) + 7) & ~7
forged_index[-20:] = hashlib.sha1(forged_index[:-20]).digest()
index_path.write_bytes(forged_index)
assert inspect()["status"], "Forged untrusted index stat cache concealed a tracked edit"
assert index_path.read_bytes() == forged_index, "Witness modified forged workspace index"
(workspace / "tracked.txt").write_text("candidate\n")
index_path.write_bytes(original_index)
assert inspect() == {"status": "", "headMoved": False}
for flag, inverse in (("--assume-unchanged", "--no-assume-unchanged"), ("--skip-worktree", "--no-skip-worktree"), ("--fsmonitor-valid", "--no-fsmonitor-valid")):
    run(["/usr/bin/git", "-c", "core.fsmonitor=false", "-C", str(workspace), "update-index", flag, "tracked.txt"], trusted=False)
    original_index = (workspace / ".git/index").read_bytes()
    (workspace / "tracked.txt").write_text("hidden tracked change\n")
    assert inspect()["status"], "Untrusted index flag concealed tracked change: " + flag
    assert (workspace / ".git/index").read_bytes() == original_index, "Witness modified workspace index"
    (workspace / "tracked.txt").write_text("candidate\n")
    run(["/usr/bin/git", "-c", "core.fsmonitor=false", "-C", str(workspace), "update-index", inverse, "tracked.txt"], trusted=False)
    assert inspect() == {"status": "", "headMoved": False}
run(["/usr/bin/python3", "-c", "import pathlib; pathlib.Path('" + str(workspace / "node_modules") + "').mkdir(); pathlib.Path('" + str(workspace / "node_modules/installed") + "').write_text('retained')"], trusted=False)
assert inspect() == {"status": "", "headMoved": False}
run(["/usr/bin/python3", "-I", "-B", sys.argv[1], "init", attempt, candidate], success=False)
assert (workspace / "node_modules/installed").read_text() == "retained"
run(["/usr/bin/python3", "-c", "import pathlib; pathlib.Path('" + str(private / attempt / "git/baseline.json") + "').read_bytes()"], trusted=False, success=False)
run(["/usr/bin/python3", "-c", "import pathlib; pathlib.Path('" + str(bundle) + "').read_bytes()"], trusted=False, success=False)
run(["/usr/bin/python3", "-I", "-B", sys.argv[1], "inspect", attempt, candidate], trusted=False, success=False)
config = workspace / ".git/config"
with config.open("a") as stream:
    stream.write("\n[core]\nfsmonitor = /usr/bin/touch /tmp/paws-monitor-ran\n[alias]\nstatus = !touch /tmp/paws-forged-alias\n")
assert inspect() == {"status": "", "headMoved": False}
assert not pathlib.Path("/tmp/paws-monitor-ran").exists()
assert not pathlib.Path("/tmp/paws-forged-alias").exists()
(workspace / "tracked.txt").write_text("changed\n")
unstaged = inspect()
assert unstaged["status"] and not unstaged["headMoved"]
run(["/usr/bin/git", "-c", "core.fsmonitor=false", "-C", str(workspace), "add", "tracked.txt"], trusted=False)
(workspace / "tracked.txt").write_text("candidate\n")
staged = inspect()
assert staged["status"] and not staged["headMoved"] and staged["status"] != unstaged["status"]
run(["/usr/bin/git", "-c", "core.fsmonitor=false", "-C", str(workspace), "reset", "--hard", candidate], trusted=False)
assert inspect() == {"status": "", "headMoved": False}
head = workspace / ".git/HEAD"
head.write_text("b" * 40 + "\n")
assert inspect() == {"status": "", "headMoved": True}
head.unlink()
head.symlink_to("/etc/passwd")
assert inspect() == {"status": None, "headMoved": True}
head.unlink()
head.write_text(candidate + "\n")
run(["/usr/bin/git", "-C", str(workspace), "status", "--porcelain"], trusted=False)
assert pathlib.Path("/tmp/paws-monitor-ran").exists()
print(json.dumps({"verified": True, "pythonVersion": sys.version, "gitVersion": git("--version"), "candidateSha": candidate, "rootAdmittedCandidateMismatchRejected": True, "daemonBundlePathReplacementCannotChangeFetchedSnapshot": True, "privateBundleSnapshotMatchesManifest": True, "freshAttemptClean": True, "installedDependenciesRetained": True, "attemptReinitializationRejected": True, "daemonPrivateMetadataReadAndReplaceDenied": True, "ordinaryCheckPrivateMetadataAndInputDenied": True, "hostileWorkspaceGitConfigNotExecuted": True, "nativeGitBaselineExecutesForgedFsmonitor": True, "worktreeAndStagedChangesDetected": True, "populatedSubmodulesRefused": True, "populatedSubmodulesRejectedBeforeStatus": True, "concurrentPopulationFailsClosedWithoutNestedStatus": True, "changedSubmoduleIndexRefused": True, "symlinkSubmoduleRefused": True, "unpopulatedSubmodulesAccepted": True, "untrustedIndexFlagsCannotHideChanges": True, "untrustedIndexStatCacheCannotHideChanges": True, "trackedFileCount": git("-C", str(seed), "ls-files", "-z").count("\0"), "workspaceIndexUnchangedByWitness": True, "hostileSubmoduleGitConfigNotExecuted": True, "actualHeadMovementDetected": True, "symlinkHeadFailsClosed": True}), flush=True)
