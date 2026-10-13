import argparse
import hashlib
import json
import os
import pathlib
import platform
import re
import stat
import subprocess
import tarfile
import tempfile


BUN_VERSION = "1.4.2"
ARCHITECTURE = {"x86_64": ("x64", "x86_64"), "aarch64": ("arm64", "aarch64")}.get(platform.machine(), ("unsupported", "unsupported"))
PROVIDER_EXECUTABLES = {
    "claude": f"node_modules/@anthropic-ai/claude-agent-sdk-linux-{ARCHITECTURE[0]}/claude",
    "codex": f"node_modules/@openai/codex-linux-{ARCHITECTURE[0]}/vendor/{ARCHITECTURE[1]}-unknown-linux-musl/bin/codex",
}
CODEX_PLATFORM_PACKAGE = f"node_modules/@openai/codex-linux-{ARCHITECTURE[0]}/package.json"
SEMVER = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
ASSETS = {
    "runner-broker.py",
    "check-broker.py",
    "check-child.py",
    "check-status.py",
    "check-metadata.py",
    "check-witness.py",
    "check-verifier.py",
    "paws-check@.service",
    "paws-check-witness@.service",
    "paws-agent@.service",
    "paws-runner.service",
    "paws-runner-broker.service",
    "paws-runner-broker.socket",
    "paws-runner.sysusers",
    "paws-runner.tmpfiles",
}
REQUIRED = {
    "bin/bun",
    "app/package.json",
    "app/bun.lock",
    "app/src/index.ts",
    "app/src/acp/ask-team-mcp.ts",
    "app/src/process/process-anchor.ts",
    "app/node_modules/.bin/claude-agent-acp",
    "app/node_modules/.bin/codex-acp",
    "app/node_modules/.bin/grok",
    "app/node_modules/.bin/claude",
    "app/node_modules/.bin/codex",
    "app/node_modules/@openai/codex/bin/codex.js",
    "app/" + CODEX_PLATFORM_PACKAGE,
} | {"app/" + target for target in PROVIDER_EXECUTABLES.values()} | {f"deploy/linux/{name}" for name in ASSETS}
COMMAND_ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C"}


def command(arguments):
    result = subprocess.run(arguments, env=COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, check=False, timeout=60)
    if result.returncode != 0:
        raise ValueError(f"Required command failed: {arguments[0]}")
    return result.stdout


def read_regular(path, limit):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise ValueError("Invalid release input file")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            content = stream.read(limit + 1)
        if len(content) > limit:
            raise ValueError("Release input exceeds size limit")
        return content
    finally:
        os.close(descriptor)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate manifest field")
        result[key] = value
    return result


def parse_manifest(content):
    manifest = json.loads(content, object_pairs_hook=unique_object)
    if not isinstance(manifest, dict) or set(manifest) != {"format", "version", "platform", "bunVersion", "artifactSha256"}:
        raise ValueError("Invalid release manifest fields")
    if type(manifest["format"]) is not int or manifest["format"] != 1 or manifest["bunVersion"] != BUN_VERSION:
        raise ValueError("Unsupported release format or Bun version")
    if not isinstance(manifest["version"], str) or len(manifest["version"]) > 32 or not SEMVER.fullmatch(manifest["version"]):
        raise ValueError("Invalid release version")
    if manifest["platform"] not in ("linux-x64", "linux-arm64") or not isinstance(manifest["artifactSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", manifest["artifactSha256"]):
        raise ValueError("Invalid release platform or artifact digest")
    return manifest


def check_platform(manifest):
    actual = {"x86_64": "linux-x64", "aarch64": "linux-arm64"}.get(platform.machine())
    if platform.system() != "Linux" or actual != manifest["platform"]:
        raise ValueError("Release does not match this Linux host")


def validate_member(member):
    name = member.name
    parts = name.split("/")
    if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or member.size < 0 or member.mode not in (0o644, 0o755) or any(part in ("", ".", "..") or not re.fullmatch(r"[A-Za-z0-9@._+-]+", part) for part in parts):
        raise ValueError("Unsafe release archive member")
    allowed = name == "bin/bun" or name in ("app/package.json", "app/bun.lock") or len(parts) > 2 and parts[:2] in (["app", "src"], ["app", "node_modules"]) or len(parts) == 3 and parts[:2] == ["deploy", "linux"] and parts[2] in ASSETS
    if not allowed:
        raise ValueError("Unexpected release archive member")
    if any(part.startswith(".") and part != ".bin" for part in parts):
        raise ValueError("Hidden release archive member")


def inspect_archive(path):
    seen = {}
    total = 0
    with open(path, "rb") as archive:
        size = os.fstat(archive.fileno()).st_size
        while True:
            header = archive.read(512)
            if len(header) != 512:
                raise ValueError("Truncated release archive")
            if header == bytes(512):
                remaining = size - archive.tell()
                if not 512 <= remaining <= 10240 or any(archive.read(remaining)):
                    raise ValueError("Unexpected release archive trailer")
                break
            if header[257:265] != b"ustar\x0000":
                raise ValueError("Unsupported release archive format")
            try:
                member = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
            except tarfile.HeaderError as error:
                raise ValueError("Invalid release archive header") from error
            validate_member(member)
            if member.name in seen:
                raise ValueError("Duplicate release archive member")
            member.offset_data = archive.tell()
            seen[member.name] = member
            total += member.size
            if len(seen) > 100000 or total > 2_147_483_648 or member.size > 536_870_912:
                raise ValueError("Release archive exceeds size limits")
            following = archive.tell() + (member.size + 511) // 512 * 512
            if following > size:
                raise ValueError("Truncated release archive payload")
            archive.seek(following)
    if not REQUIRED <= seen.keys():
        raise ValueError("Release archive is missing required runtime files")
    executable_providers = {"app/node_modules/.bin/claude", "app/node_modules/.bin/codex"} | {"app/" + target for target in PROVIDER_EXECUTABLES.values()}
    if any(seen[name].mode != 0o755 for name in executable_providers):
        raise ValueError("Bundled provider launchers and native binaries must be executable")
    return seen


def snapshot_artifact(source, destination):
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    digest = hashlib.sha256()
    total = 0
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("Invalid release artifact")
        with os.fdopen(descriptor, "rb", closefd=False) as incoming, open(destination, "xb") as outgoing:
            os.chmod(destination, 0o600)
            while True:
                chunk = incoming.read(1_048_576)
                if not chunk:
                    break
                total += len(chunk)
                if total > 2_147_483_648:
                    raise ValueError("Release artifact exceeds size limit")
                digest.update(chunk)
                outgoing.write(chunk)
            outgoing.flush()
            os.fsync(outgoing.fileno())
    finally:
        os.close(descriptor)
    return digest.hexdigest()


def verify_release(arguments, staging):
    manifest_bytes = read_regular(arguments.manifest, 65_536)
    signature = read_regular(arguments.signature, 64)
    key_bytes = read_regular(arguments.release_key, 16_384)
    if len(signature) != 64:
        raise ValueError("Ed25519 signature must be 64 bytes")
    manifest_path = staging / "manifest.json"
    signature_path = staging / "manifest.sig"
    key_path = staging / "release.pub"
    for path, content in ((manifest_path, manifest_bytes), (signature_path, signature), (key_path, key_bytes)):
        path.write_bytes(content)
        path.chmod(0o600)
    der = command(["/usr/bin/openssl", "pkey", "-pubin", "-in", str(key_path), "-outform", "DER"])
    if len(der) != 44 or der[:12] != bytes.fromhex("302a300506032b6570032100"):
        raise ValueError("Release key must be an Ed25519 public key")
    command(["/usr/bin/openssl", "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(key_path), "-sigfile", str(signature_path), "-in", str(manifest_path)])
    manifest = parse_manifest(manifest_bytes)
    check_platform(manifest)
    artifact = staging / "artifact.tar"
    if snapshot_artifact(arguments.artifact, artifact) != manifest["artifactSha256"]:
        raise ValueError("Release artifact digest mismatch")
    inspect_archive(artifact)
    return manifest, artifact, hashlib.sha256(der).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("verify",))
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--signature", required=True)
    parser.add_argument("--artifact", required=True)
    parser.add_argument("--release-key", required=True)
    arguments = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="paws-release-") as directory:
        manifest, _, fingerprint = verify_release(arguments, pathlib.Path(directory))
        print(json.dumps({"verified": True, "version": manifest["version"], "platform": manifest["platform"], "releaseKeyFingerprint": fingerprint}))


if __name__ == "__main__":
    main()
