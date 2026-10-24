import argparse
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import stat
import subprocess
import tarfile
import tempfile


spec = importlib.util.spec_from_file_location("paws_release", pathlib.Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SAFE_NAME = re.compile(r"[A-Za-z0-9@._+-]+")
# Source directories only the control plane runs. The dashboard is built and served there, never on a runner.
CONTROL_PLANE_ONLY = frozenset({("web",)})


def read_package_file(path, limit):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("Invalid package source file")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            content = stream.read(limit + 1)
        if len(content) > limit:
            raise ValueError("Package source file exceeds size limit")
        return content
    finally:
        os.close(descriptor)


def add_content(archive, name, content, executable=False):
    member = tarfile.TarInfo(name)
    member.mode = 0o755 if executable else 0o644
    member.size = len(content)
    release.validate_member(member)
    archive.addfile(member, io.BytesIO(content))


def development_only(manifest):
    try:
        root = json.loads(manifest)
    except ValueError as error:
        raise ValueError("Invalid package manifest") from error
    if not isinstance(root, dict):
        raise ValueError("Invalid package manifest")
    names = [set(root.get(field) or {}) for field in ("dependencies", "optionalDependencies", "devDependencies")]
    return frozenset(names[2] - names[0] - names[1])


def package_names(parts):
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


def package_root(parts):
    if not parts:
        return False
    if len(parts) >= 2 and parts[-2].startswith("@"):
        return len(parts) == 2 or parts[-3] == "node_modules"
    return not parts[-1].startswith("@") and (len(parts) == 1 or parts[-2] == "node_modules")


def runtime_dependencies(content):
    try:
        manifest = json.loads(content)
    except ValueError:
        return set()
    if not isinstance(manifest, dict):
        return set()
    return {name for field in ("dependencies", "optionalDependencies") if isinstance(manifest.get(field), dict) for name in manifest[field]}


def left_out(parts, development):
    names = package_names(parts)
    return bool(names) and (names[0] in development or any(name.endswith("-musl") for name in names))


def install_production(bun, source, workspace):
    for name in ("package.json", "bun.lock"):
        (workspace / name).write_bytes(read_package_file(source / name, 16_777_216))
    home = workspace / "home"
    home.mkdir()
    completed = subprocess.run(
        [str(bun), "install", "--frozen-lockfile", "--production"],
        cwd=workspace,
        env={**release.COMMAND_ENV, "HOME": str(home)},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=900,
    )
    if completed.returncode != 0:
        detail = " ".join(completed.stderr.decode(errors="replace").splitlines()[-8:])[:800]
        raise ValueError(f"Production dependency install failed: {detail}")
    return workspace / "node_modules"


def pack(arguments):
    source = pathlib.Path(arguments.source).resolve(strict=True)
    bun = pathlib.Path(arguments.bun).resolve(strict=True)
    if not release.SEMVER.fullmatch(arguments.version) or len(arguments.version) > 32:
        raise ValueError("Invalid release version")
    if arguments.platform not in ("linux-x64", "linux-arm64"):
        raise ValueError("Invalid release platform")
    release.check_platform({"platform": arguments.platform})
    provider_targets = {
        "claude": release.PROVIDER_EXECUTABLES["claude"],
        "codex": "node_modules/@openai/codex/bin/codex.js",
    }
    manifest = read_package_file(source / "package.json", 16_777_216)
    development = development_only(manifest)
    runtime = read_package_file(bun, 536_870_912)
    actual_version = subprocess.run([str(bun), "--version"], env=release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=10).stdout.decode().strip()
    if actual_version != release.BUN_VERSION:
        raise ValueError("Pinned Bun runtime is required")
    with tempfile.TemporaryDirectory(prefix="paws-runner-dependencies-") as workspace:
        modules = pathlib.Path(install_production(bun, source, pathlib.Path(workspace))).resolve(strict=True)
        return pack_with(arguments, source, bun, runtime, manifest, development, modules, provider_targets)


def pack_with(arguments, source, bun, runtime, manifest, development, modules, provider_targets):
    for target in {*provider_targets.values(), *release.PROVIDER_EXECUTABLES.values(), release.CODEX_PLATFORM_PACKAGE}:
        path = modules / pathlib.PurePosixPath(target).relative_to("node_modules")
        read_package_file(path, 536_870_912)
        if target in release.PROVIDER_EXECUTABLES.values() and not path.stat().st_mode & 0o111:
            raise ValueError("Bundled provider executable must be executable")
    output = pathlib.Path(arguments.output)
    output.mkdir(mode=0o700)
    mise = release.verify_mise(read_package_file(arguments.mise, release.MISE_LIMIT), arguments.platform) if arguments.mise else release.download_mise(arguments.platform)
    artifact = output / "artifact.tar"
    launcher_targets = set()
    with tarfile.open(artifact, "w", format=tarfile.USTAR_FORMAT) as archive:
        add_content(archive, "bin/bun", runtime, True)
        add_content(archive, "bin/mise", mise, True)
        add_content(archive, "bin/paws-runner", release.RUNNER_LAUNCHER, True)
        add_content(archive, "app/package.json", manifest)
        add_content(archive, "app/bun.lock", read_package_file(source / "bun.lock", 16_777_216))
        for name, target in provider_targets.items():
            interpreter = "/opt/paws-runner/bin/bun --no-env-file " if name == "codex" else ""
            content = ("#!/bin/sh\nexec " + interpreter + "'/opt/paws-runner/current/" + target + "' \"$@\"\n").encode()
            add_content(archive, f"app/node_modules/.bin/{name}", content, True)
        required_by_packed = set()
        for directory, base in (("src", source / "src"), ("node_modules", modules)):
            if base.is_symlink() or not base.is_dir():
                raise ValueError("Runtime source and dependencies must be directories")
            bin_directory = base / ".bin"
            for current, directories, files in os.walk(base, followlinks=False):
                current = pathlib.Path(current)
                directories[:] = sorted(
                    name
                    for name in directories
                    if (not name.startswith(".") or name == ".bin")
                    and (directory == "src" and (current / name).relative_to(base).parts not in CONTROL_PLANE_ONLY or directory == "node_modules" and SAFE_NAME.fullmatch(name) and not left_out((current / name).relative_to(base).parts, development))
                )
                for name in directories:
                    if (current / name).is_symlink():
                        raise ValueError("Linked package directories are unsupported")
                for name in sorted(files):
                    if name.startswith(".") or directory == "node_modules" and not SAFE_NAME.fullmatch(name) and not (current / name).is_symlink():
                        continue
                    path = current / name
                    if path.parent == bin_directory and name in provider_targets:
                        continue
                    relative = directory + "/" + path.relative_to(base).as_posix()
                    if path.is_symlink():
                        if path.parent != bin_directory or not re.fullmatch(r"[A-Za-z0-9._+-]+", name):
                            raise ValueError("Only fixed adapter launcher links can be packaged")
                        target = path.resolve(strict=True)
                        if not target.is_relative_to(modules):
                            raise ValueError("Adapter launcher escapes dependencies")
                        if left_out(target.relative_to(modules).parts, development):
                            continue
                        target_relative = "node_modules/" + target.relative_to(modules).as_posix()
                        target_member = tarfile.TarInfo("app/" + target_relative)
                        target_member.mode = 0o644
                        release.validate_member(target_member)
                        launcher_targets.add(target_member.name)
                        content = read_package_file(target, 536_870_912)
                        installed = "/opt/paws-runner/current/" + target_relative
                        interpreter = "/opt/paws-runner/bin/bun --no-env-file " if content.startswith(b"#!") and b"node" in content.split(b"\n", 1)[0] else ""
                        content = ("#!/bin/sh\nexec " + interpreter + "'" + installed + "' \"$@\"\n").encode()
                        add_content(archive, "app/" + relative, content, True)
                    else:
                        content = read_package_file(path, 536_870_912)
                        if directory == "node_modules" and name == "package.json" and package_root(path.parent.relative_to(base).parts):
                            required_by_packed |= runtime_dependencies(content)
                        add_content(archive, "app/" + relative, content, bool(path.stat().st_mode & 0o111))
        if required_by_packed & development:
            raise ValueError("A packaged dependency needs a development dependency: " + ", ".join(sorted(required_by_packed & development)))
        for name in sorted(release.ASSETS):
            add_content(archive, f"deploy/linux/{name}", read_package_file(source / "deploy/linux" / name, 1_048_576))
    members = release.inspect_archive(artifact)
    if any(name.startswith("app/src/web/") for name in members):
        raise ValueError("The dashboard must not ship in the runner package")
    if not launcher_targets <= members.keys():
        raise ValueError("Adapter launcher target is missing from the release")
    with artifact.open("rb") as completed:
        digest_state = hashlib.sha256()
        while chunk := completed.read(1_048_576):
            digest_state.update(chunk)
        digest = digest_state.hexdigest()
    manifest = {"format": 1, "version": arguments.version, "platform": arguments.platform, "bunVersion": release.BUN_VERSION, "artifactSha256": digest}
    (output / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--bun", required=True)
    parser.add_argument("--mise", help="Local copy of the pinned mise binary; downloaded and checked when omitted")
    parser.add_argument("--version", required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--output", required=True)
    print(json.dumps(pack(parser.parse_args())))


if __name__ == "__main__":
    main()
