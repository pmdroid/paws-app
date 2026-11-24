#!/bin/sh
set -eu

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "Run provision.sh as root"
if [ $# -ne 1 ] || [ ! -f "$1" ]; then
  die "Usage: provision.sh <image.env>"
fi
. "$1"

arch=$(dpkg --print-architecture)
case $arch in
  amd64) runner_sha256=$PAWS_RUNNER_SHA256_amd64; kind_sha256=$KIND_SHA256_amd64 ;;
  arm64) runner_sha256=$PAWS_RUNNER_SHA256_arm64; kind_sha256=$KIND_SHA256_arm64 ;;
  *) die "Unsupported architecture: $arch" ;;
esac

fetch() {
  curl --proto '=https' --tlsv1.2 -fsSL --retry 5 --retry-delay 2 -o "$1" "$2"
  printf '%s  %s\n' "$3" "$1" | sha256sum -c --quiet - || die "Checksum mismatch for $2"
}

printf '%s\n' 'vm.overcommit_memory = 1' > /etc/sysctl.d/90-paws-overcommit.conf
chmod 0644 /etc/sysctl.d/90-paws-overcommit.conf
sysctl -q -p /etc/sysctl.d/90-paws-overcommit.conf

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y -o Dpkg::Options::=--force-confold full-upgrade
apt-get -y --no-install-recommends install $APT_PACKAGES

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

deb="$workdir/paws-runner_${PAWS_RUNNER_VERSION}_$arch.deb"
fetch "$deb" "https://github.com/pmdroid/paws-app/releases/download/v$PAWS_RUNNER_VERSION/paws-runner_${PAWS_RUNNER_VERSION}_$arch.deb" "$runner_sha256"
chmod 0644 "$deb"
PAWS_RUNNER_DOCKER_ACCESS=grant apt-get -y install "$deb"

fetch "$workdir/kind" "https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-linux-$arch" "$kind_sha256"
install -m 0755 "$workdir/kind" /usr/local/bin/kind

apt-get -y autoremove --purge
systemctl enable docker.service ssh.service

install -d -m 0755 /etc/paws-issue-vm
install -m 0644 "$1" /etc/paws-issue-vm/image.env

[ -x /opt/paws-runner/bin/paws-runner ] || die "paws-runner is not installed"
[ ! -e /etc/paws-runner/config.json ] || die "The image must not hold a runner enrollment"
docker version >/dev/null
kind version >/dev/null
tries=0
until runuser -u paws-agent -- docker --host unix:///run/paws-agent-docker/docker.sock info >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 30 ] || die "paws-agent could not reach its rootless Docker daemon"
  sleep 1
done
