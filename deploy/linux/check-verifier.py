import base64
import ctypes
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys


ROOT = "/var/lib/paws-check-verifier"
PUBLIC = "/var/lib/paws-check-verifier-public.pem"
DOMAIN = b"paws.runner-check-result.v1\0"


def directory():
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in ROOT.split("/")[1:]:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
        info = os.fstat(descriptor)
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("Unsafe verifier key directory")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def private_key(parent):
    descriptor = os.open("key.pem", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or not 0 < info.st_size <= 1024:
        os.close(descriptor)
        raise ValueError("Unsafe verifier private key")
    return descriptor


def openssl(arguments, descriptors=()):
    return subprocess.run(["/usr/bin/openssl", *arguments], pass_fds=descriptors, stdin=subprocess.DEVNULL, capture_output=True, env={"PATH": "/usr/bin:/bin", "LANG": "C"}, timeout=10, check=True).stdout


def public_identity(parent):
    descriptor = private_key(parent)
    try:
        pem = openssl(["pkey", "-in", "/proc/self/fd/" + str(descriptor), "-pubout"], (descriptor,))
        der = openssl(["pkey", "-in", "/proc/self/fd/" + str(descriptor), "-pubout", "-outform", "DER"], (descriptor,))
    finally:
        os.close(descriptor)
    if len(der) != 44 or der[:12] != bytes.fromhex("302a300506032b6570032100"):
        raise ValueError("Verifier requires Ed25519")
    return {"verifierPublicKeyPem": pem.decode("ascii"), "fingerprint": hashlib.sha256(der).hexdigest()}


def publish_file(parent, name, content, mode):
    temporary = name + ".pending-" + os.urandom(16).hex()
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        os.fchmod(descriptor, mode)
        os.fchown(descriptor, 0, 0)
        with os.fdopen(os.dup(descriptor), "wb") as stream:
            stream.write(content)
            stream.flush()
        os.fsync(descriptor)
        if ctypes.CDLL(None, use_errno=True).renameat2(parent, os.fsencode(temporary), parent, os.fsencode(name), 1) != 0:
            raise OSError(ctypes.get_errno(), "Cannot atomically publish verifier identity")
        os.fsync(parent)
    finally:
        os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.fsync(parent)


def initialize():
    if os.getuid() != 0:
        raise ValueError("Privileged verifier installation required")
    previous_umask = os.umask(0o077)
    try:
        try:
            os.mkdir(ROOT, mode=0o700)
        except FileExistsError:
            pass
    finally:
        os.umask(previous_umask)
    parent = directory()
    public_parent = os.open("/var/lib", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            descriptor = private_key(parent)
        except FileNotFoundError:
            try:
                os.stat("paws-check-verifier-public.pem", dir_fd=public_parent, follow_symlinks=False)
            except FileNotFoundError:
                publish_file(parent, "key.pem", openssl(["genpkey", "-algorithm", "ED25519"]), 0o600)
            else:
                raise ValueError("Existing verifier public identity requires its private key")
        else:
            os.close(descriptor)
        identity = public_identity(parent)
        try:
            publish_file(public_parent, "paws-check-verifier-public.pem", identity["verifierPublicKeyPem"].encode("ascii"), 0o644)
        except FileExistsError:
            descriptor = os.open("paws-check-verifier-public.pem", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=public_parent)
            info = os.fstat(descriptor)
            try:
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o644 or os.read(descriptor, 257) != identity["verifierPublicKeyPem"].encode("ascii"):
                    raise ValueError("Existing verifier public identity differs")
            finally:
                os.close(descriptor)
        return identity
    finally:
        os.close(public_parent)
        os.close(parent)


def signing_bytes(result):
    fields = {"format", "executionId", "verificationAttemptId", "candidateSha", "inputSha256", "exitCode", "signal", "timedOut", "stdout", "stderr", "stdoutTruncated", "stderrTruncated", "durationMs", "dirty", "headMoved"}
    if not isinstance(result, dict) or set(result) != fields or type(result["format"]) is not int or result["format"] != 1:
        raise ValueError("Invalid verifier result")
    for field in ("executionId", "verificationAttemptId"):
        if not isinstance(result[field], str) or not re.fullmatch(r"[0-7][0-9A-HJKMNP-TV-Z]{25}", result[field]):
            raise ValueError("Invalid verifier identifier")
    for field, size in (("candidateSha", 40), ("inputSha256", 64)):
        if not isinstance(result[field], str) or not re.fullmatch(r"[a-f0-9]{" + str(size) + r"}", result[field]):
            raise ValueError("Invalid verifier digest")
    for field in ("timedOut", "stdoutTruncated", "stderrTruncated", "dirty", "headMoved"):
        if type(result[field]) is not bool:
            raise ValueError("Invalid verifier boolean")
    for field in ("stdout", "stderr"):
        if not isinstance(result[field], str) or len(result[field].encode("utf-8")) > 1048576:
            raise ValueError("Invalid verifier output")
    if type(result["durationMs"]) is not int or not 0 <= result["durationMs"] <= 9007199254740991:
        raise ValueError("Invalid verifier duration")
    exited = type(result["exitCode"]) is int and 0 <= result["exitCode"] <= 255 and result["signal"] is None
    signaled = result["exitCode"] is None and type(result["signal"]) is int and 1 <= result["signal"] <= 64
    if not (exited or signaled):
        raise ValueError("Invalid verifier wait status")
    return DOMAIN + json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sign_pending_result(parent, expected, runner_gid):
    descriptor = os.open("result.pending", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != runner_gid or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o640 or info.st_size > 13000000:
            raise ValueError("Unsafe root verifier result")
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            result = json.loads(stream.read(13000001))
    finally:
        os.close(descriptor)
    if any(result.get(key) != value for key, value in expected.items()):
        raise ValueError("Root verifier result binding differs")
    payload = signing_bytes(result)
    root = directory()
    key = None
    message = None
    try:
        key = private_key(root)
        message = os.memfd_create("paws-verifier-result", os.MFD_CLOEXEC)
        with os.fdopen(os.dup(message), "wb") as stream:
            stream.write(payload)
            stream.flush()
        signature = openssl(["pkeyutl", "-sign", "-rawin", "-inkey", "/proc/self/fd/" + str(key), "-in", "/proc/self/fd/" + str(message)], (key, message))
        if len(signature) != 64:
            raise ValueError("Invalid root verifier signature")
        return base64.b64encode(signature).decode("ascii")
    finally:
        for descriptor in (message, key, root):
            if descriptor is not None:
                os.close(descriptor)


if __name__ == "__main__":
    if sys.argv[1:] != ["initialize"]:
        raise ValueError("Only privileged identity initialization is supported")
    print(json.dumps(initialize(), sort_keys=True, separators=(",", ":")), flush=True)
