set -euo pipefail
# Install, upgrade and remove the control-plane RPM in each container image given as an argument,
# with a fixture in place of the Bun binary. Needs rpmbuild and Docker on the host.
umask 022
here=$(realpath "$(dirname "$0")")
work=$(mktemp -d /tmp/paws-rpm.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
printf '#!/bin/sh\necho paws fixture\n' > "$work/paws"
case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) echo "Unsupported architecture" >&2; exit 1 ;; esac
for version in 1.0.0 1.0.1; do
  python3 -I -B "$here/rpm-package.py" --binary "$work/paws" --version "$version" --architecture "$arch" --output "$work/rpms"
done
cat > "$work/check.sh" <<'CHECK'
set -euxo pipefail
cd /rpms
sha256sum -c paws-control-plane-1.0.0-1.*.rpm.sha256 paws-control-plane-1.0.1-1.*.rpm.sha256
dnf install -y ./paws-control-plane-1.0.0-1.*.rpm
getent passwd paws | grep -q ':/var/lib/paws:/usr/sbin/nologin$'
getent group paws
test -f /usr/lib/systemd/system/paws.service
test -L /etc/systemd/system/multi-user.target.wants/paws.service
test "$(stat -c '%a %U %G' /etc/paws/control-plane.env)" = '600 root paws'
test "$(stat -c '%a %U %G' /var/lib/paws)" = '700 paws paws'
test "$(paws)" = 'paws fixture'
printf 'PAWS_PUBLIC_URL=https://paws.test\n' >> /etc/paws/control-plane.env
saved=$(sha256sum /etc/paws/control-plane.env)
install -d -o paws -g paws -m 0700 /var/lib/paws/pglite
echo database > /var/lib/paws/pglite/data
dnf upgrade -y ./paws-control-plane-1.0.1-1.*.rpm
test "$(rpm -q --qf '%{VERSION}' paws-control-plane)" = 1.0.1
test "$(sha256sum /etc/paws/control-plane.env)" = "$saved"
test ! -e /etc/paws/control-plane.env.rpmnew
test "$(cat /var/lib/paws/backups/pglite-1.0.0-*/data)" = database
test -L /etc/systemd/system/multi-user.target.wants/paws.service
dnf remove -y paws-control-plane
test ! -e /usr/lib/systemd/system/paws.service
test ! -e /etc/systemd/system/multi-user.target.wants/paws.service
grep -qx 'PAWS_PUBLIC_URL=https://paws.test' /etc/paws/control-plane.env.rpmsave
CHECK
for image in "$@"; do
  echo "::group::$image"
  docker run --rm -v "$work/rpms:/rpms:ro" -v "$work/check.sh:/check.sh:ro" "$image" bash /check.sh
  echo "::endgroup::"
done
