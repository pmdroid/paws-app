import base64
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile


if os.getuid() != 0:
    raise RuntimeError("Disposable root namespace required")
spec = importlib.util.spec_from_file_location("verifier", "/proof/check-verifier.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
root = pathlib.Path(verifier.ROOT)
key = root / "key.pem"
public = pathlib.Path(verifier.PUBLIC)
environment = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C.UTF-8"}


def credentials(uid):
    def change():
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
    return change


def initialize(uid=0, accepted=True):
    process = subprocess.run(["/usr/bin/python3", "-I", "-B", "/proof/check-verifier.py", "initialize"], preexec_fn=credentials(uid), env=environment, capture_output=True, text=True, timeout=15)
    assert (process.returncode == 0) == accepted, process.stderr
    return json.loads(process.stdout) if accepted else None


identity = initialize()
original = {path: (path.stat().st_ino, path.read_bytes()) for path in (key, public)}
assert initialize() == identity
assert all((path.stat().st_ino, path.read_bytes()) == value for path, value in original.items())
assert root.stat().st_uid == root.stat().st_gid == 0 and root.stat().st_mode & 0o7777 == 0o700
assert key.stat().st_uid == key.stat().st_gid == 0 and key.stat().st_mode & 0o7777 == 0o600
assert public.stat().st_uid == public.stat().st_gid == 0 and public.stat().st_mode & 0o7777 == 0o644
for uid in (1001, 1005):
    initialize(uid, False)
    denied = subprocess.run(["/usr/bin/python3", "-I", "-B", "-c", "import pathlib;pathlib.Path('/var/lib/paws-check-verifier/key.pem').read_bytes()"], preexec_fn=credentials(uid), env=environment, capture_output=True, timeout=5)
    assert denied.returncode != 0

refused = 0
for path, mode in ((root, 0o700), (key, 0o600), (public, 0o644)):
    for unsafe in (mode | 0o020, mode | 0o001):
        path.chmod(unsafe)
        initialize(accepted=False)
        path.chmod(mode)
        refused += 1
    for uid, gid in ((1001, 0), (0, 1005)):
        os.chown(path, uid, gid)
        initialize(accepted=False)
        os.chown(path, 0, 0)
        refused += 1
    moved = path.with_name(path.name + ".retained")
    path.rename(moved)
    path.symlink_to(moved)
    initialize(accepted=False)
    path.unlink()
    moved.rename(path)
    refused += 1
for path in (key, public):
    linked = path.with_name(path.name + ".link")
    os.link(path, linked)
    initialize(accepted=False)
    linked.unlink()
    refused += 1
    original_bytes = path.read_bytes()
    path.write_bytes(b"invalid identity")
    initialize(accepted=False)
    path.write_bytes(original_bytes)
    refused += 1
    path.unlink()
    os.mkfifo(path, 0o600 if path == key else 0o644)
    initialize(accepted=False)
    path.unlink()
    path.write_bytes(original_bytes)
    path.chmod(0o600 if path == key else 0o644)
    refused += 1
saved = key.with_name("key.retained")
key.rename(saved)
initialize(accepted=False)
assert not key.exists()
saved.rename(key)
refused += 1
assert initialize() == identity

retained_key = key.read_bytes()
wrong_key = subprocess.run(["/usr/bin/openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256"], env=environment, capture_output=True, timeout=10, check=True).stdout
key.write_bytes(wrong_key)
initialize(accepted=False)
key.write_bytes(retained_key)
refused += 1
assert initialize() == identity

directory = pathlib.Path(tempfile.mkdtemp(prefix="paws-signing-result-"))
directory.chmod(0o750)
os.chown(directory, 0, 1001)
pending = directory / "result.pending"
result = {"format": 1, "executionId": "01K00000000000000000000001", "verificationAttemptId": "01K00000000000000000000002", "candidateSha": "a" * 40, "inputSha256": "b" * 64, "exitCode": 0, "signal": None, "timedOut": False, "stdout": "日本語 🐕 e\u0301 \u2028\u2029\0\n\"\\", "stderr": "診断\t🙂", "stdoutTruncated": False, "stderrTruncated": False, "durationMs": 123, "dirty": False, "headMoved": False}
pending.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
os.chown(pending, 0, 1001)
pending.chmod(0o640)
expected = {field: result[field] for field in ("executionId", "verificationAttemptId", "candidateSha", "inputSha256")}
parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)


def sign(binding=expected, accepted=True):
    try:
        value = verifier.sign_pending_result(parent, binding, 1001)
    except (ValueError, OSError, subprocess.CalledProcessError):
        assert not accepted
        return None
    assert accepted
    return value


signature = sign()
pending.write_text(json.dumps(dict(reversed(list(result.items()))), ensure_ascii=True))
assert sign() == signature
for field in expected:
    sign({**expected, field: "different"}, False)
for uid, gid, mode in ((1001, 1001, 0o640), (0, 1005, 0o640), (0, 1001, 0o660)):
    os.chown(pending, uid, gid)
    pending.chmod(mode)
    sign(accepted=False)
os.chown(pending, 0, 1001)
pending.chmod(0o640)
linked = directory / "linked"
os.link(pending, linked)
sign(accepted=False)
linked.unlink()
pending.rename(linked)
pending.symlink_to(linked)
sign(accepted=False)
pending.unlink()
linked.rename(pending)
pending.unlink()
os.mkfifo(pending, 0o640)
os.chown(pending, 0, 1001)
sign(accepted=False)
pending.unlink()
os.close(parent)
receipt = directory / "receipt.json"
receipt.write_text(json.dumps({"result": result, "signature": signature, "identity": identity, "canonical": base64.b64encode(verifier.signing_bytes(result)).decode("ascii")}, ensure_ascii=False))
receipt.chmod(0o640)
os.chown(receipt, 0, 1001)
consumer = subprocess.run(["/proof/bun", "--no-env-file", "/proof/consumer.js", str(receipt)], preexec_fn=credentials(1001), env=environment, capture_output=True, text=True, timeout=15)
assert consumer.returncode == 0, consumer.stderr
verified = json.loads(consumer.stdout)
assert verified["uid"] == 1001
print(json.dumps({"identityReopenStable": True, "rootDirectoryMode": "0700", "privateKeyMode": "0600", "publicKeyMode": "0644", "ordinaryUidsDenied": [1001, 1005], "unsafeIdentityCasesRefused": refused, "pendingBindingMismatchesRefused": len(expected), "unsafePendingCasesRefused": 6, "unicodeAndReorderedSignaturesMatch": True, "publicVerifier": verified}), flush=True)
