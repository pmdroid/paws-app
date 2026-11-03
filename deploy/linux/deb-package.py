import argparse
import hashlib
import importlib.util
import pathlib
import shutil
import subprocess
import tempfile


ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release", ROOT / "release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def write(path, content, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(mode)


def postrm(units, root=""):
    """The package's postrm. `root` prefixes every host path, so a test can run it against a fake root."""
    paths = [*(f"{root}/etc/systemd/system/{name}" for name in units), f"{root}/etc/sysusers.d/paws-runner.conf", f"{root}/etc/tmpfiles.d/paws-runner.conf"]
    return f"""#!/bin/sh
set -eu
case "$1" in
  failed-upgrade)
    if [ -f {root}/usr/lib/paws-runner-package/deb-control.py ]; then
      /usr/bin/python3 -I -B {root}/usr/lib/paws-runner-package/deb-control.py restore
    fi
    ;;
  remove|purge)
    if command -v systemctl >/dev/null 2>&1; then
      systemctl disable --now -- paws-runner-agents.path || true
      systemctl disable -- paws-runner.service paws-runner-broker.socket paws-runner-broker.service || true
      if [ -e {root}/etc/systemd/system/paws-docker.service ]; then
        systemctl disable --now -- paws-docker.service || true
      fi
    fi
    rm -rf -- {root}/opt/paws-runner
    rm -f -- {" ".join(paths)} {root}/var/lib/paws-runner-install/debian-services.json
    rm -f -- {root}/etc/systemd/system/paws-docker.service {root}/etc/systemd/system/paws-agent@.service.d/docker.conf
    rmdir -- {root}/etc/systemd/system/paws-agent@.service.d 2>/dev/null || true
    if command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload || true
    fi
    ;;
esac
if [ "$1" = purge ]; then
  rm -f -- {root}/etc/paws-runner/config.json
  rm -rf -- {root}/var/lib/paws-agent-docker
  for file in {root}/etc/subuid {root}/etc/subgid; do
    if [ -f "$file" ] && grep -q '^paws-agent:' "$file"; then
      sed -i '/^paws-agent:/d' "$file"
    fi
  done
fi
"""


def build(arguments):
    # The vendored rootless Docker launcher must be the pinned upstream file before anything is built.
    launcher = release.verify_dockerd_rootless(release.read_regular(ROOT / "dockerd-rootless.sh", 1_048_576))
    output = pathlib.Path(arguments.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="paws-deb-") as temporary:
        root = pathlib.Path(temporary)
        manifest, artifact, _ = release.verify_release(arguments, root)
        architecture = {"linux-x64": "amd64", "linux-arm64": "arm64"}[manifest["platform"]]
        package = root / "package"
        payload = package / "usr/lib/paws-runner-package"
        payload.mkdir(parents=True)
        for source, name in ((artifact, "artifact.tar"), (root / "manifest.json", "manifest.json"), (root / "manifest.sig", "manifest.sig"), (root / "release.pub", "release.pub"), *((ROOT / name, name) for name in ("install.py", "release.py", "deb-control.py"))):
            shutil.copyfile(source, payload / name)
            (payload / name).chmod(0o644)
        (payload / "dockerd-rootless.sh").write_bytes(launcher)
        (payload / "dockerd-rootless.sh").chmod(0o755)
        size = sum(path.stat().st_size for path in payload.iterdir())
        write(package / "DEBIAN/control", f"Package: paws-runner\nVersion: {manifest['version']}\nArchitecture: {architecture}\nMaintainer: pmdroid <pmdroid@users.noreply.github.com>\nSection: devel\nPriority: optional\nDepends: git, openssl (>= 3), python3, util-linux, coreutils (>= 8.28), systemd\nInstalled-Size: {(size + 1023) // 1024}\nHomepage: https://github.com/pmdroid/paws-app\nDescription: Paws remote Linux runner\n Runs paired coding agents and isolated verification for Paws.\n")
        write(package / "DEBIAN/postinst", '#!/bin/sh\nset -eu\ncase "$1" in\n  configure) exec /usr/bin/python3 -I -B /usr/lib/paws-runner-package/deb-control.py configure ;;\n  abort-upgrade|abort-remove|abort-deconfigure) exec /usr/bin/python3 -I -B /usr/lib/paws-runner-package/deb-control.py restore ;;\nesac\n', 0o755)
        write(package / "DEBIAN/prerm", '#!/bin/sh\nset -eu\ncase "$1" in\n  upgrade) exec /usr/bin/python3 -I -B /usr/lib/paws-runner-package/deb-control.py stop --next-version "$2" ;;\n  remove|deconfigure) exec /usr/bin/python3 -I -B /usr/lib/paws-runner-package/deb-control.py stop ;;\nesac\n', 0o755)
        units = sorted(name for name in release.ASSETS if name.endswith((".service", ".socket", ".path")))
        write(package / "DEBIAN/postrm", postrm(units), 0o755)
        for directory in [package, *[path for path in package.rglob("*") if path.is_dir()]]:
            directory.chmod(0o755)
        destination = output / f"paws-runner_{manifest['version']}_{architecture}.deb"
        subprocess.run(["dpkg-deb", "--root-owner-group", "--threads-max=2", "-Zgzip", "-z6", "--build", str(package), str(destination)], check=True)
        with destination.open("rb") as completed:
            digest = hashlib.file_digest(completed, "sha256").hexdigest()
        write(destination.with_suffix(".deb.sha256"), f"{digest}  {destination.name}\n")
        return destination


def main():
    parser = argparse.ArgumentParser()
    for name in ("manifest", "signature", "artifact", "release-key", "output"):
        parser.add_argument("--" + name, required=True)
    print(build(parser.parse_args()))


if __name__ == "__main__":
    main()
