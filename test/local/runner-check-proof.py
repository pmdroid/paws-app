import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile


if os.getuid() != 0:
    raise RuntimeError("Disposable root namespace required")
root = pathlib.Path(tempfile.mkdtemp(prefix="paws-check-proof-"))
root.chmod(0o755)
for path, uid, gid, mode in ((root / "daemon", 1001, 1001, 0o700), (root / "inputs", 1001, 1004, 0o2750), (root / "inputs/attempts", 1001, 1004, 0o2750), (root / "inputs/commands", 1001, 1004, 0o2750), (pathlib.Path("/var/lib/paws-check-attempts"), 0, 1005, 0o750), (root / "results", 0, 1001, 0o750)):
    path.mkdir()
    os.chown(path, uid, gid)
    path.chmod(mode)


def run(mode, uid):
    def credentials():
        os.setgroups([1004] if uid == 1001 else [])
        os.setgid(uid)
        os.setuid(uid)
    result = subprocess.run([sys.argv[1], "--no-env-file", sys.argv[2], mode, str(root)], preexec_fn=credentials, env={"PATH": "/usr/bin:/bin", "HOME": str(root / "daemon") if uid == 1001 else "/nonexistent"}, capture_output=True, text=True, timeout=15, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr)
    return json.loads(result.stdout)


assert run("publish", 1001) == {"published": True}
execution_id = "01K00000000000000000000001"
input_path = root / "inputs/commands" / execution_id / "job.json"
job = json.loads(input_path.read_bytes())
attempt_root = "/var/lib/paws-check-attempts/" + job["verificationAttemptId"]
assert job["cwd"] == attempt_root + "/workspace"
assert job["env"] == {"HOME": attempt_root + "/home", "TMPDIR": attempt_root + "/tmp", "PATH": "/opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "CI": "1"}
directory = root / "results" / execution_id
directory.mkdir(mode=0o750)
os.chown(directory, 0, 1001)
result = {"format": 1, "executionId": execution_id, "verificationAttemptId": job["verificationAttemptId"], "candidateSha": job["candidateSha"], "inputSha256": hashlib.sha256(input_path.read_bytes()).hexdigest(), "exitCode": 0, "signal": None, "timedOut": True, "stdout": "trusted witness output", "stderr": "", "stdoutTruncated": False, "stderrTruncated": False, "durationMs": 123, "dirty": False, "headMoved": False}
path = directory / "result.json"
path.write_text(json.dumps(result))
os.chown(path, 0, 1001)
path.chmod(0o640)
assert run("read", 1001) == {"read": True, "writeDenied": True}
path.write_text(json.dumps({**result, "stdout": "\0" * 1_048_576, "stderr": "\0" * 1_048_576}))
assert run("read-binary", 1001) == {"readBinary": True}
path.write_text(json.dumps(result))
for uid in (1002, 1005):
    assert run("deny", uid) == {"inputDenied": True, "publishDenied": True, "resultDenied": True}
for change in ({"candidateSha": "b" * 40}, {"inputSha256": "c" * 64}, {"verificationAttemptId": "01K00000000000000000000002"}):
    path.write_text(json.dumps({**result, **change}))
    assert run("reject", 1001) == {"rejected": True}
path.write_text(json.dumps(result))
path.chmod(0o660)
assert run("reject", 1001) == {"rejected": True}
path.chmod(0o640)
linked = directory / "linked.json"
os.link(path, linked)
assert run("reject", 1001) == {"rejected": True}
linked.unlink()
path.rename(linked)
path.symlink_to(linked)
assert run("reject", 1001) == {"rejected": True}
path.unlink()
linked.rename(path)
assert run("sign-witness", 0) == {"signed": True}
assert run("read-signature", 1001) == {"signatureVerified": True, "writeDenied": True}
signature_path = directory / "verifier-signature"
signature = signature_path.read_bytes()
signature_path.write_bytes((b"A" if signature[:1] != b"A" else b"B") + signature[1:])
assert run("reject-signature", 1001) == {"rejectedSignature": True}
signature_path.write_bytes(signature)
for mode, uid, gid in ((0o660, 0, 1001), (0o640, 1001, 1001), (0o640, 0, 1002)):
    signature_path.chmod(mode)
    os.chown(signature_path, uid, gid)
    assert run("reject-signature", 1001) == {"rejectedSignature": True}
signature_path.chmod(0o640)
os.chown(signature_path, 0, 1001)
signature_link = directory / "signature-link"
os.link(signature_path, signature_link)
assert run("reject-signature", 1001) == {"rejectedSignature": True}
signature_link.unlink()
signature_path.rename(signature_link)
signature_path.symlink_to(signature_link)
assert run("reject-signature", 1001) == {"rejectedSignature": True}
signature_path.unlink()
signature_link.rename(signature_path)
for content in (signature + b"\n", signature[:-1], b"A" * 88):
    signature_path.write_bytes(content)
    assert run("reject-signature", 1001) == {"rejectedSignature": True}
signature_path.unlink()
os.mkfifo(signature_path, 0o640)
os.chown(signature_path, 0, 1001)
assert run("reject-signature", 1001) == {"rejectedSignature": True}
print(json.dumps({"verified": True, "runnerUid": 1001, "agentUid": 1002, "checkUid": 1005, "inputGid": 1004, "fixedCheckEnvironmentDerived": True, "publicCanonicalInputDigestMatches": True, "rootWitnessResultRead": True, "boundedEscapedBinaryOutputRead": True, "daemonResultWriteDenied": True, "agentAndCheckInputDenied": True, "agentAndCheckResultForgeryDenied": True, "candidateAttemptAndInputDigestMismatchRejected": True, "writableHardlinkAndSymlinkResultRejected": True, "rootWitnessSignatureVerified": True, "daemonSignatureWriteDenied": True, "alteredUnsafeAndMalformedSignaturesRejected": True, "signatureFifoRejectedWithoutBlocking": True}), flush=True)
