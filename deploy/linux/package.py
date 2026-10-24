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


def compile_runner(bun, source, destination):
    with tempfile.TemporaryDirectory(prefix="paws-runner-compile-") as home:
        completed = subprocess.run(
            [str(bun), "build", str(source / "src" / "index.ts"), "--compile", "--outfile", str(destination), "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--target=bun"],
            cwd=source,
            env={**release.COMMAND_ENV, "HOME": home},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=900,
        )
    if completed.returncode != 0:
        detail = " ".join(completed.stderr.decode(errors="replace").splitlines()[-8:])[:800]
        raise ValueError(f"Runner compilation failed: {detail}")
    content = read_package_file(destination, 536_870_912)
    destination.unlink()
    if not content.startswith(b"\x7fELF"):
        raise ValueError("Compiled runner is not a native executable")
    return content


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
    for target in {*provider_targets.values(), *release.PROVIDER_EXECUTABLES.values(), release.CODEX_PLATFORM_PACKAGE}:
        read_package_file(source / target, 536_870_912)
        if target in release.PROVIDER_EXECUTABLES.values() and not (source / target).stat().st_mode & 0o111:
            raise ValueError("Bundled provider executable must be executable")
    output = pathlib.Path(arguments.output)
    output.mkdir(mode=0o700)
    runtime = read_package_file(bun, 536_870_912)
    actual_version = subprocess.run([str(bun), "--version"], env=release.COMMAND_ENV, stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=10).stdout.decode().strip()
    if actual_version != release.BUN_VERSION:
        raise ValueError("Pinned Bun runtime is required")
    mise = release.verify_mise(read_package_file(arguments.mise, release.MISE_LIMIT), arguments.platform) if arguments.mise else release.download_mise(arguments.platform)
    compiled = compile_runner(bun, source, output / "paws-runner")
    artifact = output / "artifact.tar"
    launcher_targets = set()
    with tarfile.open(artifact, "w", format=tarfile.USTAR_FORMAT) as archive:
        add_content(archive, "bin/bun", runtime, True)
        add_content(archive, "bin/mise", mise, True)
        add_content(archive, "bin/paws-runner", compiled, True)
        for name in ("package.json", "bun.lock"):
            add_content(archive, f"app/{name}", read_package_file(source / name, 16_777_216))
        for name, target in provider_targets.items():
            interpreter = "/opt/paws-runner/bin/bun --no-env-file " if name == "codex" else ""
            content = ("#!/bin/sh\nexec " + interpreter + "'/opt/paws-runner/current/" + target + "' \"$@\"\n").encode()
            add_content(archive, f"app/node_modules/.bin/{name}", content, True)
        for directory in ("src", "node_modules"):
            base = source / directory
            if base.is_symlink() or not base.is_dir():
                raise ValueError("Runtime source and dependencies must be directories")
            for current, directories, files in os.walk(base, followlinks=False):
                directories[:] = sorted(name for name in directories if (not name.startswith(".") or name == ".bin") and (directory == "src" or SAFE_NAME.fullmatch(name)))
                for name in directories:
                    if (pathlib.Path(current) / name).is_symlink():
                        raise ValueError("Linked package directories are unsupported")
                for name in sorted(files):
                    if name.startswith(".") or directory == "node_modules" and not SAFE_NAME.fullmatch(name) and not (pathlib.Path(current) / name).is_symlink():
                        continue
                    path = pathlib.Path(current) / name
                    if path.parent == source / "node_modules/.bin" and name in provider_targets:
                        continue
                    relative = path.relative_to(source).as_posix()
                    if path.is_symlink():
                        if path.parent != source / "node_modules/.bin" or not re.fullmatch(r"[A-Za-z0-9._+-]+", name):
                            raise ValueError("Only fixed adapter launcher links can be packaged")
                        target = path.resolve(strict=True)
                        if not target.is_relative_to(source / "node_modules"):
                            raise ValueError("Adapter launcher escapes dependencies")
                        target_name = "app/" + target.relative_to(source).as_posix()
                        target_member = tarfile.TarInfo(target_name)
                        target_member.mode = 0o644
                        release.validate_member(target_member)
                        launcher_targets.add(target_name)
                        content = read_package_file(target, 536_870_912)
                        installed = "/opt/paws-runner/current/" + target.relative_to(source).as_posix()
                        interpreter = "/opt/paws-runner/bin/bun --no-env-file " if content.startswith(b"#!") and b"node" in content.split(b"\n", 1)[0] else ""
                        content = ("#!/bin/sh\nexec " + interpreter + "'" + installed + "' \"$@\"\n").encode()
                        add_content(archive, "app/" + relative, content, True)
                    else:
                        add_content(archive, "app/" + relative, read_package_file(path, 536_870_912), bool(path.stat().st_mode & 0o111))
        for name in sorted(release.ASSETS):
            add_content(archive, f"deploy/linux/{name}", read_package_file(source / "deploy/linux" / name, 1_048_576))
    members = release.inspect_archive(artifact)
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
