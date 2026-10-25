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
import urllib.request


BUN_VERSION = "1.4.2"
MISE_VERSION = "2026.10.18"
MISE_SHA256 = {
    "linux-x64": "e97c38973336aa2ff350fea50f47b412b266fe263b102b7200ff1e9b118c6942",
    "linux-arm64": "3a3c72376687ba21a588d0f5a2c88c76f483fb6cdece7b0fc43d5e3132b08a52",
}
MISE_LIMIT = 268_435_456
ARCHITECTURE = {"x86_64": ("x64", "x86_64"), "aarch64": ("arm64", "aarch64")}.get(platform.machine(), ("unsupported", "unsupported"))
# The coding agents are not in the release. The installer installs each one from npm into
# /opt/paws-runner/agents/<agent>/<version> from the pinned lockfile in agents.json.
AGENT_PACKAGES = {
    "claude": "@agentclientprotocol/claude-agent-acp",
    "codex": "@agentclientprotocol/codex-acp",
    "grok": "@xai-official/grok",
}
# The agents and the packages that carry their native builds (and every platform variant of those).
AGENT_ONLY = frozenset({*AGENT_PACKAGES.values(), "@anthropic-ai/claude-agent-sdk", "@openai/codex"})
CODEX_VENDOR = f"node_modules/@openai/codex-linux-{ARCHITECTURE[0]}/vendor/{ARCHITECTURE[1]}-unknown-linux-musl"
# Launchers in /opt/paws-runner/bin: launcher name -> (agent, file inside the agent's version folder,
# whether it is a node script run on the bundled Bun). The installer checks each kind before a version
# is put in place, so a launcher never guesses.
PROVIDER_EXECUTABLES = {
    "claude-agent-acp": ("claude", "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", True),
    "claude": ("claude", f"node_modules/@anthropic-ai/claude-agent-sdk-linux-{ARCHITECTURE[0]}/claude", False),
    "codex-acp": ("codex", "node_modules/@agentclientprotocol/codex-acp/dist/index.js", True),
    "codex": ("codex", "node_modules/@openai/codex/bin/codex.js", True),
    "grok": ("grok", "node_modules/@xai-official/grok/bin/grok", True),
}
# The package that carries each agent's native builds; the Paws catalog names the version it expects.
AGENT_NATIVE_PACKAGE = {
    "claude": "@anthropic-ai/claude-agent-sdk",
    "codex": "@openai/codex",
    "grok": "@xai-official/grok",
}
# Native files each agent needs, which must be executable after install.
AGENT_NATIVE = {
    "claude": (f"node_modules/@anthropic-ai/claude-agent-sdk-linux-{ARCHITECTURE[0]}/claude",),
    "codex": (CODEX_VENDOR + "/bin/codex",),
    "grok": (),
}
# Removed from the staged install before it is put in place. Codex's voice host is for the
# interactive voice mode, which agent sessions never start. codex-code-mode-host stays: the Codex
# binary checks its package layout and starts it when features.code_mode_host is on.
AGENT_DROPPED = {
    "claude": (),
    "codex": (CODEX_VENDOR + "/codex-resources/voice",),
    "grok": (),
}
AGENT_MANIFEST_LIMIT = 8_388_608
INTEGRITY = re.compile(r"sha512-[A-Za-z0-9+/]{86}==\Z")
PACKAGE_PATH = re.compile(r"(?:@[A-Za-z0-9][A-Za-z0-9._-]*/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:/(?:@[A-Za-z0-9][A-Za-z0-9._-]*/)?[A-Za-z0-9][A-Za-z0-9._-]*)*\Z")
EXACT_VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?\Z")
SEMVER = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
ASSETS = {
    "agents.json",
    "paws-agent@.service",
    "paws-runner.service",
    "paws-runner-agents.path",
    "paws-runner-agents.service",
    "paws-runner.sysusers",
    "paws-runner.tmpfiles",
}
REQUIRED = {
    "bin/bun",
    "bin/mise",
    "bin/paws-runner",
    "app/package.json",
    "app/bun.lock",
    "app/src/index.ts",
    "app/src/runner-cli/main.ts",
    "app/src/acp/ask-team-mcp.ts",
    "app/src/process/process-anchor.ts",
} | {f"deploy/linux/{name}" for name in ASSETS}
BINARIES = ("bin/bun", "bin/mise", "bin/paws-runner")
# bin/paws-runner runs the runner entry on the bundled Bun, so the release carries Bun once.
# Bun would otherwise read .env and bunfig.toml (which can preload code) from the working directory.
RUNNER_LAUNCHER = b"#!/bin/sh\nexec /opt/paws-runner/bin/bun --no-env-file --config=/dev/null /opt/paws-runner/current/src/runner-cli/main.ts \"$@\"\n"
COMMAND_ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C"}


def command(arguments):
    result = subprocess.run(arguments, env=COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, check=False, timeout=60)
    if result.returncode != 0:
        raise ValueError(f"Required command failed: {arguments[0]}")
    return result.stdout


def mise_url(platform_name):
    if platform_name not in MISE_SHA256:
        raise ValueError("Unsupported mise platform")
    return f"https://github.com/jdx/mise/releases/download/v{MISE_VERSION}/mise-v{MISE_VERSION}-{platform_name}"


def verify_mise(content, platform_name):
    if platform_name not in MISE_SHA256:
        raise ValueError("Unsupported mise platform")
    if hashlib.sha256(content).hexdigest() != MISE_SHA256[platform_name]:
        raise ValueError(f"mise {MISE_VERSION} {platform_name} checksum mismatch")
    return content


def download_mise(platform_name, opener=urllib.request.urlopen):
    with opener(mise_url(platform_name), timeout=300) as response:
        content = response.read(MISE_LIMIT + 1)
    if len(content) > MISE_LIMIT:
        raise ValueError("mise download exceeds size limit")
    return verify_mise(content, platform_name)


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
    allowed = name in BINARIES or name in ("app/package.json", "app/bun.lock") or len(parts) > 2 and parts[:2] in (["app", "src"], ["app", "node_modules"]) or len(parts) == 3 and parts[:2] == ["deploy", "linux"] and parts[2] in ASSETS
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
    shipped = {package_names(name.removeprefix("app/node_modules/").split("/"))[0] for name in seen if name.startswith("app/node_modules/") and not name.startswith("app/node_modules/.bin/")}
    if any(name in AGENT_ONLY or name.startswith(tuple(package + "-" for package in AGENT_ONLY)) for name in shipped) or any(name.startswith("app/node_modules/.bin/") and name.rsplit("/", 1)[1] in PROVIDER_EXECUTABLES for name in seen):
        raise ValueError("Coding agents are installed from agents.json, not shipped in the release")
    if seen["bin/mise"].mode != 0o755:
        raise ValueError("Bundled mise must be executable")
    if seen["bin/paws-runner"].mode != 0o755:
        raise ValueError("Bundled runner launcher must be executable")
    return seen


def package_names(parts):
    """Package names along a node_modules path: a/node_modules/@b/c/x.js -> [a, @b/c]."""
    names = []
    index = 0
    while index < len(parts):
        if index == 0 or parts[index - 1] == "node_modules":
            if parts[index].startswith("@"):
                if index + 1 == len(parts):
                    break
                names.append(parts[index] + "/" + parts[index + 1])
                index += 1
            elif parts[index] not in ("node_modules", ".bin"):
                names.append(parts[index])
        index += 1
    return names


def strip_trailing_commas(text):
    """bun.lock is JSON with trailing commas. Drop each comma that closes an object or array."""
    output = []
    in_string = False
    escaped = False
    index = 0
    while index < len(text):
        character = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
        elif character == '"':
            in_string = True
        elif character == ",":
            following = index + 1
            while following < len(text) and text[following] in " \t\r\n":
                following += 1
            if following < len(text) and text[following] in "}]":
                index += 1
                continue
        output.append(character)
        index += 1
    return "".join(output)


def parse_lockfile(text):
    lockfile = json.loads(strip_trailing_commas(text), object_pairs_hook=unique_object)
    if not isinstance(lockfile, dict) or not isinstance(lockfile.get("packages"), dict) or not isinstance(lockfile.get("workspaces"), dict):
        raise ValueError("Invalid bun.lock")
    return lockfile


def agent_package_json(agent, version):
    return {"name": f"paws-agent-{agent}", "private": True, "dependencies": {AGENT_PACKAGES[agent]: version}}


def check_agent_entry(agent, entry):
    """Check one agents.json entry: every package its lockfile can install is listed with its exact version and sha512."""
    if not isinstance(entry, dict) or set(entry) != {"package", "version", "packages", "lockfile"}:
        raise ValueError(f"Invalid agent manifest entry for {agent}")
    if entry["package"] != AGENT_PACKAGES[agent] or not isinstance(entry["version"], str) or len(entry["version"]) > 64 or not EXACT_VERSION.fullmatch(entry["version"]):
        raise ValueError(f"Invalid agent package or version for {agent}")
    lockfile = entry["lockfile"]
    if not isinstance(lockfile, dict) or set(lockfile) - {"lockfileVersion", "configVersion", "workspaces", "packages"} or not isinstance(lockfile.get("packages"), dict):
        raise ValueError(f"Invalid lockfile for {agent}")
    expected = agent_package_json(agent, entry["version"])
    if lockfile.get("workspaces") != {"": {"name": expected["name"], "dependencies": expected["dependencies"]}}:
        raise ValueError(f"The {agent} lockfile does not pin {entry['package']}@{entry['version']}")
    listed = entry["packages"]
    if not isinstance(listed, list) or not listed:
        raise ValueError(f"Invalid package list for {agent}")
    packages = {}
    for item in listed:
        if not isinstance(item, dict) or set(item) != {"path", "name", "version", "integrity"} or not all(isinstance(item[key], str) for key in item):
            raise ValueError(f"Invalid package entry for {agent}")
        if not PACKAGE_PATH.fullmatch(item["path"]) or not PACKAGE_PATH.fullmatch(item["name"]) or not EXACT_VERSION.fullmatch(item["version"]) or not INTEGRITY.fullmatch(item["integrity"]) or item["path"] in packages:
            raise ValueError(f"Invalid package entry for {agent}: {item.get('path')}")
        packages[item["path"]] = item
    if set(packages) != set(lockfile["packages"]):
        raise ValueError(f"The {agent} lockfile and package list differ")
    for path, locked in lockfile["packages"].items():
        item = packages[path]
        # [name@version, registry tarball ("" = the default registry), metadata, integrity]
        if not isinstance(locked, list) or len(locked) != 4 or locked[0] != f"{item['name']}@{item['version']}" or locked[1] != "" or not isinstance(locked[2], dict) or locked[3] != item["integrity"]:
            raise ValueError(f"The {agent} lockfile entry {path} does not match its pinned version and integrity")
    if packages.get(entry["package"], {}).get("version") != entry["version"]:
        raise ValueError(f"The {agent} lockfile does not install {entry['package']}@{entry['version']}")
    return entry


def parse_agent_manifest(content):
    """Check agents.json: every package the lockfile can install is listed with its exact version and sha512."""
    manifest = json.loads(content, object_pairs_hook=unique_object)
    if not isinstance(manifest, dict) or set(manifest) != {"format", "agents"} or manifest["format"] != 1 or type(manifest["format"]) is not int:
        raise ValueError("Invalid agent manifest")
    agents = manifest["agents"]
    if not isinstance(agents, dict) or set(agents) != set(AGENT_PACKAGES):
        raise ValueError("The agent manifest must list exactly the claude, codex and grok agents")
    for agent, entry in agents.items():
        check_agent_entry(agent, entry)
    return manifest


def agent_entry(bun, agent, version, workspace, seed=None, registry=None, pins=None):
    """Resolve one agent version's lockfile into an agents.json entry.

    `seed` is a bun.lock whose resolutions are kept; `registry` replaces npm (tests, or the registry
    the runner installs from). `pins` maps package names to the exact versions the resolution must
    take, such as the native build version the Paws catalog checked inside an adapter's range. They
    resolve as overrides, which are then left out of the lockfile: the resolved versions stay pinned
    in it, and the installed package.json still names only the agent. No install script runs and
    nothing is installed: only the lockfile is written.
    """
    package = agent_package_json(agent, version)
    (workspace / "package.json").write_text(json.dumps({**package, **({"overrides": dict(pins)} if pins else {})}))
    if seed is not None:
        (workspace / "bun.lock").write_bytes(seed)
    home = workspace / "home"
    home.mkdir()
    completed = subprocess.run(
        [str(bun), "install", "--lockfile-only", "--ignore-scripts"],
        cwd=workspace,
        env={**COMMAND_ENV, "HOME": str(home), "BUN_INSTALL_CACHE_DIR": str(home / "cache"), **({"BUN_CONFIG_REGISTRY": registry} if registry else {})},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=600,
    )
    if completed.returncode != 0:
        raise ValueError(f"Could not resolve the {agent} lockfile: {completed.stderr.decode(errors='replace')[-800:]}")
    lockfile = parse_lockfile((workspace / "bun.lock").read_text())
    lockfile["workspaces"] = {"": {"name": package["name"], "dependencies": package["dependencies"]}}
    lockfile.pop("trustedDependencies", None)
    lockfile.pop("overrides", None)
    packages = []
    for path, locked in sorted(lockfile["packages"].items()):
        # The installer always names the registry itself; a lockfile entry never points at a tarball URL.
        if registry and isinstance(locked, list) and len(locked) > 1 and isinstance(locked[1], str) and locked[1].startswith(registry):
            locked[1] = ""
        name, _, exact = locked[0].rpartition("@")
        packages.append({"path": path, "name": name, "version": exact, "integrity": locked[3]})
    return {"package": AGENT_PACKAGES[agent], "version": version, "packages": packages, "lockfile": lockfile}


AGENT_REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")


def parse_agent_requests(content):
    """The agent versions Paws sent the runner: {"format": 1, "requests": [{id, agent, version, integrity, nativeVersion, packages}]}.

    `integrity` is the npm sha512 of the agent package from the Paws catalog. `packages` lists the native
    build package and the platform packages it pins, each with the sha512 the catalog checked; it is
    never empty. At most one request per agent.
    """
    document = json.loads(content, object_pairs_hook=unique_object)
    if not isinstance(document, dict) or set(document) != {"format", "requests"} or document["format"] != 1 or type(document["format"]) is not int or not isinstance(document["requests"], list):
        raise ValueError("Invalid agent request file")
    seen = set()
    for request in document["requests"]:
        if not isinstance(request, dict) or set(request) != {"id", "agent", "version", "integrity", "nativeVersion", "packages"}:
            raise ValueError("Invalid agent request")
        if not isinstance(request["id"], str) or not AGENT_REQUEST_ID.fullmatch(request["id"]) or request["agent"] not in AGENT_PACKAGES or request["agent"] in seen:
            raise ValueError("Invalid agent request")
        for key in ("version", "nativeVersion"):
            value = request[key]
            if (value is not None or key == "version") and (not isinstance(value, str) or len(value) > 64 or not EXACT_VERSION.fullmatch(value)):
                raise ValueError(f"Invalid agent request {key}")
        if not isinstance(request["integrity"], str) or not INTEGRITY.fullmatch(request["integrity"]):
            raise ValueError("Invalid agent request integrity")
        packages = request["packages"]
        if not isinstance(packages, list) or not packages or len(packages) > 64:
            raise ValueError("Invalid agent request packages")
        for item in packages:
            if not isinstance(item, dict) or set(item) != {"name", "version", "integrity"} or not all(isinstance(item[key], str) for key in item):
                raise ValueError("Invalid agent request package")
            if not PACKAGE_PATH.fullmatch(item["name"]) or item["name"].count("/") > (1 if item["name"].startswith("@") else 0) or len(item["version"]) > 64 or not EXACT_VERSION.fullmatch(item["version"]) or not INTEGRITY.fullmatch(item["integrity"]):
                raise ValueError("Invalid agent request package")
        seen.add(request["agent"])
    return document["requests"]


def agent_launcher(name, base="/opt/paws-runner"):
    """Launcher that runs an agent from its current version folder and holds that folder for the session.

    The shared flock on the version folder is inherited by the agent and everything it starts, so the
    installer can tell whether a session still uses a version before it moves `current`.
    """
    agent, target, script = PROVIDER_EXECUTABLES[name]
    folder = f"{base}/agents/{agent}"
    interpreter = f"{base}/bin/bun --no-env-file " if script else ""
    return (
        "#!/bin/sh\n"
        "set -eu\n"
        f"version=$(/usr/bin/readlink -e -- '{folder}/current') || {{ echo 'Coding agent {agent} is not installed. Reinstall paws-runner.' >&2; exit 127; }}\n"
        'exec 9<"$version"\n'
        "/usr/bin/flock --shared 9\n"
        f'exec {interpreter}"$version/{target}" "$@"\n'
    ).encode()


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
