"""Build the paws-control-plane RPM with rpmbuild, from the same payload as the control-plane .deb."""

import argparse
import hashlib
import importlib.util
import pathlib
import subprocess
import tempfile


ROOT = pathlib.Path(__file__).resolve().parent


def load(name):
    specification = importlib.util.spec_from_file_location(name.replace("-", "_"), ROOT / (name + ".py"))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


release = load("release")
deb_package = load("deb-package")
deb_control = load("deb-control")

ARCHITECTURES = {"amd64": "x86_64", "arm64": "aarch64"}
# The .deb's Depends, by package or by the shared library the Bun binary loads, so the names hold on
# Fedora, RHEL, Rocky, Alma and openSUSE alike. awk reads the environment file before an upgrade.
SCRIPT_REQUIRES = ("systemd", "coreutils", "findutils", "/usr/bin/awk")
REQUIRES = (*SCRIPT_REQUIRES, "libc.so.6()(64bit)", "libstdc++.so.6()(64bit)", "libgcc_s.so.1()(64bit)")
ENVIRONMENT = "/etc/paws/control-plane.env"


def scripts(root=""):
    """The package's scriptlets as plain shell. `root` prefixes every host path, so a test can run them against a fake root.

    rpm passes the number of installed copies after the operation: 1 on install, 2 on upgrade, 0 on erase. Without a
    running systemd (a container or a chroot) the unit is enabled but not stopped or started.
    """
    systemd = f"[ -d {root}/run/systemd/system ]"
    sysusers = (ROOT / "paws.sysusers").read_text()
    return {
        # User and group come first: the environment file belongs to the paws group.
        "pre": f"""set -eu
systemd-sysusers --replace={root}/usr/lib/sysusers.d/paws.conf - <<'SYSUSERS'
{sysusers.rstrip()}
SYSUSERS
if [ "$1" -gt 1 ]; then
  previous=$(timeout 30 rpm -q --qf '%{{VERSION}}\\n' paws-control-plane 2>/dev/null | head -n 1) || previous=
  case "$previous" in ""|*[!0-9A-Za-z.+~^_-]*) previous=unknown ;; esac
{deb_control.control_plane_settings(root)}  staging=
  stopped=
  if {systemd}; then systemctl stop paws.service; stopped=1; fi
  trap 'status=$?; trap - 0; if [ -n "$staging" ]; then rm -rf -- "$staging" || true; fi; if [ "$status" -ne 0 ] && [ -n "$stopped" ]; then systemctl start paws.service || true; fi; exit "$status"' 0
{deb_control.control_plane_backup("$previous")}fi
""",
        "post": f"""set -eu
systemd-tmpfiles --create {root}/usr/lib/tmpfiles.d/paws.conf
if [ -f {root}{ENVIRONMENT} ]; then
  chown root:paws {root}{ENVIRONMENT}
  chmod 0600 {root}{ENVIRONMENT}
fi
if {systemd}; then systemctl daemon-reload; fi
if [ "$1" -eq 1 ]; then systemctl enable paws.service; fi
""",
        # After the old package's files are gone, so an upgrade starts the new binary once.
        "posttrans": f"""set -eu
if {systemd} && [ -f {root}{ENVIRONMENT} ]; then
  systemctl daemon-reload
  systemctl start paws.service
fi
""",
        "preun": f"""set -eu
if [ "$1" -eq 0 ]; then
  if {systemd}; then systemctl disable --now paws.service; else systemctl disable paws.service; fi
fi
""",
        "postun": f"""set -eu
if {systemd}; then
  systemctl daemon-reload
  if [ "$1" -ge 1 ]; then systemctl try-restart paws.service; fi
fi
""",
    }


def spec(version, payload):
    """The spec file. rpm expands % in scriptlet bodies, so each script's % is doubled."""
    sections = "".join(f"\n%{name}\n{body.replace('%', '%%')}" for name, body in scripts().items())
    requires = "".join(f"Requires: {name}\n" for name in REQUIRES) + "".join(f"Requires(pre): {name}\n" for name in SCRIPT_REQUIRES)
    return f"""Name: paws-control-plane
Version: {version}
Release: 1
Summary: Paws control plane
License: Proprietary
URL: https://github.com/pmdroid/paws-app
AutoReqProv: no
{requires}
%description
Delegates Linear issues to paired Linux runners.

%install
cp -a -- {payload}/. %{{buildroot}}/
{sections}
%files
%defattr(-,root,root,0755)
%dir /usr/lib/paws
/usr/lib/paws/paws
/usr/bin/paws
/usr/lib/systemd/system/paws.service
/usr/lib/sysusers.d/paws.conf
/usr/lib/tmpfiles.d/paws.conf
%dir /etc/paws
%config(noreplace) %attr(0600,root,paws) {ENVIRONMENT}
"""


def build(arguments):
    if not release.SEMVER.fullmatch(arguments.version):
        raise ValueError("Invalid release version")
    if arguments.architecture not in ARCHITECTURES:
        raise ValueError("Invalid architecture")
    architecture = ARCHITECTURES[arguments.architecture]
    output = pathlib.Path(arguments.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="paws-control-plane-rpm-") as temporary:
        top = pathlib.Path(temporary)
        payload = top / "payload"
        deb_package.stage_control_plane(arguments.binary, payload)
        for directory in [payload, *[path for path in payload.rglob("*") if path.is_dir() and not path.is_symlink()]]:
            directory.chmod(0o755)
        specification = top / "paws-control-plane.spec"
        specification.write_text(spec(arguments.version, payload))
        defines = {
            "_topdir": str(top),
            "_rpmdir": str(output),
            "_build_name_fmt": "%%{NAME}-%%{VERSION}-%%{RELEASE}.%%{ARCH}.rpm",
            # The Bun binary carries its sources after the ELF image: stripping it, or anything else that rewrites it, breaks it.
            "__os_install_post": "%{nil}",
            "__arch_install_post": "%{nil}",
            "_missing_build_ids_terminate_build": "0",
            "__strip": "/bin/true",
            "debug_package": "%{nil}",
            "_build_id_links": "none",
            "_binary_payload": "w6.gzdio",
            # SHA-256 file digests, which RHEL 9 in FIPS mode requires.
            "_binary_filedigest_algorithm": "8",
            "_source_filedigest_algorithm": "8",
        }
        command = ["rpmbuild", "-bb", "--quiet", "--target", architecture]
        for name, value in defines.items():
            command += ["--define", f"{name} {value}"]
        subprocess.run([*command, str(specification)], check=True, stdout=subprocess.DEVNULL)
    destination = output / f"paws-control-plane-{arguments.version}-1.{architecture}.rpm"
    with destination.open("rb") as completed:
        digest = hashlib.file_digest(completed, "sha256").hexdigest()
    deb_package.write(destination.with_suffix(".rpm.sha256"), f"{digest}  {destination.name}\n")
    return destination


def main():
    parser = argparse.ArgumentParser()
    for name in ("binary", "version", "architecture", "output"):
        parser.add_argument("--" + name, required=True)
    print(build(parser.parse_args()))


if __name__ == "__main__":
    main()
