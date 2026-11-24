#!/bin/bash
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/image.env"

work=${PAWS_IMAGE_WORK:-/var/lib/paws-issue-vm-build}
tap=${PAWS_IMAGE_TAP:-pawsimg0}
net=${PAWS_IMAGE_NET:-10.199.250}
host_ip=$net.1
guest_ip=$net.2
cpus=${PAWS_IMAGE_CPUS:-4}
memory=${PAWS_IMAGE_MEMORY:-4G}
timeout=${PAWS_IMAGE_TIMEOUT:-1800}

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

usage() {
  printf '%s\n' "Usage: base-disk.sh build [--out DIR] [--size SIZE]" \
    "       base-disk.sh check IMAGE [--size SIZE]" \
    "Builds the issue VM base disk with Cloud Hypervisor, or boots a copy of one and checks it."
}

need() {
  for tool do
    command -v "$tool" >/dev/null 2>&1 || die "Missing command: $tool"
  done
}

case $(uname -m) in
  x86_64) arch=amd64; ch_asset="cloud-hypervisor-static" ;;
  aarch64) arch=arm64; ch_asset="cloud-hypervisor-static-aarch64" ;;
  *) die "Unsupported machine: $(uname -m)" ;;
esac
image_sha=UBUNTU_IMAGE_SHA256_$arch
ch_sha=CLOUD_HYPERVISOR_SHA256_$arch
firmware_name=CLOUDHV_FIRMWARE_$arch
firmware_sha=CLOUDHV_FIRMWARE_SHA256_$arch
image_name=paws-issue-vm-$UBUNTU_SERIAL-runner-$PAWS_RUNNER_VERSION-$arch.raw

download() {
  local path=$1 url=$2 sha=$3
  if [ ! -f "$path" ] || ! printf '%s  %s\n' "$sha" "$path" | sha256sum -c --quiet - 2>/dev/null; then
    rm -f "$path.part"
    curl --proto '=https' --tlsv1.2 -fsSL --retry 5 --retry-delay 2 -o "$path.part" "$url"
    printf '%s  %s\n' "$sha" "$path.part" | sha256sum -c --quiet - || die "Checksum mismatch for $url"
    mv "$path.part" "$path"
  fi
}

fetch_tools() {
  mkdir -p "$work/cache"
  download "$work/cache/$ch_asset-$CLOUD_HYPERVISOR_VERSION" \
    "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/$CLOUD_HYPERVISOR_VERSION/$ch_asset" "${!ch_sha}"
  chmod 0755 "$work/cache/$ch_asset-$CLOUD_HYPERVISOR_VERSION"
  download "$work/cache/$CLOUDHV_FIRMWARE_RELEASE-${!firmware_name}" \
    "https://github.com/cloud-hypervisor/edk2/releases/download/$CLOUDHV_FIRMWARE_RELEASE/${!firmware_name}" "${!firmware_sha}"
  hypervisor=$work/cache/$ch_asset-$CLOUD_HYPERVISOR_VERSION
  firmware=$work/cache/$CLOUDHV_FIRMWARE_RELEASE-${!firmware_name}
}

loop=""
mounted=""
vm_pid=""
nat=""
forward_before=""

cleanup() {
  set +e
  [ -z "$vm_pid" ] || { kill "$vm_pid" 2>/dev/null; wait "$vm_pid" 2>/dev/null; }
  [ -z "$mounted" ] || umount "$mounted"
  [ -z "$loop" ] || losetup -d "$loop"
  if [ -n "$nat" ]; then
    nft delete table ip paws_image_build 2>/dev/null
    [ -z "$forward_before" ] || sysctl -qw net.ipv4.ip_forward="$forward_before"
  fi
  ip link delete "$tap" 2>/dev/null
  return 0
}
trap cleanup EXIT

start_nat() {
  forward_before=$(sysctl -n net.ipv4.ip_forward)
  nat=1
  nft -f - <<EOF
table ip paws_image_build {
  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname "$tap" accept
    oifname "$tap" ct state established,related accept
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr $net.0/24 oifname != "$tap" masquerade
  }
}
EOF
  sysctl -qw net.ipv4.ip_forward=1
}

write_seed() {
  local dir=$1 image=$2
  cat > "$dir/meta-data" <<EOF
instance-id: paws-image-$(date +%s)
local-hostname: paws-image
EOF
  cat > "$dir/network-config" <<EOF
version: 2
ethernets:
  id0:
    match: { name: "en*" }
    addresses: [ "$guest_ip/24" ]
    routes: [ { to: default, via: "$host_ip" } ]
    nameservers: { addresses: [ "1.1.1.1", "9.9.9.9" ] }
EOF
  rm -f "$image"
  truncate -s 8M "$image"
  mkfs.vfat -n CIDATA "$image" >/dev/null
  mcopy -o -i "$image" "$dir"/* ::/
}

boot() {
  local disk=$1 seed=$2 serial=$3
  ip link delete "$tap" 2>/dev/null || true
  timeout "$timeout" "$hypervisor" --kernel "$firmware" \
    --disk "path=$disk,image_type=raw" "path=$seed,readonly=on,image_type=raw" \
    --cpus "boot=$cpus" --memory "size=$memory" \
    --net "tap=$tap,ip=$host_ip,mask=255.255.255.0,mac=52:54:00:c7:fa:02" \
    --serial "file=$serial" --console off &
  vm_pid=$!
}

attach() {
  loop=$(losetup --find --show --partscan "$1")
  udevadm settle 2>/dev/null || true
  mounted=$(mktemp -d)
  mount "${loop}p1" "$mounted"
}

detach() {
  umount "$mounted"
  rmdir "$mounted"
  mounted=""
  losetup -d "$loop"
  loop=""
}

inspect() {
  local root=$1 failed=0
  fail() {
    printf 'Image check failed: %s\n' "$1" >&2
    failed=1
  }
  [ -f "$root/etc/paws-issue-vm/sealed" ] || fail "the seal step did not finish"
  compgen -G "$root/etc/ssh/ssh_host_*" >/dev/null && fail "SSH host keys are left in /etc/ssh"
  case $(cat "$root/etc/machine-id" 2>/dev/null) in
    ""|uninitialized) ;;
    *) fail "/etc/machine-id is set" ;;
  esac
  [ ! -e "$root/var/lib/cloud/instance" ] || fail "cloud-init instance state is left"
  [ -z "$(ls -A "$root/var/lib/cloud/instances" 2>/dev/null)" ] || fail "cloud-init instances are left"
  [ ! -e "$root/etc/netplan/50-cloud-init.yaml" ] || fail "the build's network config is left"
  [ ! -e "$root/etc/paws-runner/config.json" ] || fail "a runner enrollment is left"
  [ -z "$(ls -A "$root/var/lib/paws-runner" 2>/dev/null)" ] || fail "runner state is left in /var/lib/paws-runner"
  [ -z "$(find "$root/root" "$root/home" -name authorized_keys 2>/dev/null)" ] || fail "an authorized_keys file is left"
  [ -z "$(find "$root/var/lib/docker" "$root/var/lib/paws-agent-docker" "$root/var/lib/paws-runner-docker" -name engine-id 2>/dev/null)" ] || fail "a Docker engine id is left"
  local release=$root/opt/paws-runner/releases/$PAWS_RUNNER_VERSION/bin/paws-runner
  if [ ! -f "$release" ] || [ -L "$release" ] || [ ! -x "$release" ]; then
    fail "paws-runner $PAWS_RUNNER_VERSION is missing"
  fi
  case $(readlink "$root/opt/paws-runner/current" 2>/dev/null) in
    "/opt/paws-runner/releases/$PAWS_RUNNER_VERSION"|"releases/$PAWS_RUNNER_VERSION") ;;
    *) fail "the runner's current release is not $PAWS_RUNNER_VERSION" ;;
  esac
  [ "$(readlink "$root/opt/paws-runner/bin/paws-runner" 2>/dev/null)" = ../current/bin/paws-runner ] || fail "the paws-runner command does not point at the current release"
  grep -qx 'vm.overcommit_memory = 1' "$root/etc/sysctl.d/90-paws-overcommit.conf" 2>/dev/null || fail "vm.overcommit_memory is not set to 1"
  [ -x "$root/usr/local/bin/kind" ] || fail "kind is missing"
  [ -x "$root/usr/bin/dockerd" ] || fail "Docker Engine is missing"
  [ "$failed" -eq 0 ]
}

build() {
  local out=$PWD/out size=8G
  while [ $# -gt 0 ]; do
    case $1 in
      --out) out=$2; shift 2 ;;
      --size) size=$2; shift 2 ;;
      *) usage >&2; exit 1 ;;
    esac
  done
  fetch_tools
  local dir=$work/build-$arch
  rm -rf "$dir"
  mkdir -p "$dir/seed" "$out"
  local cloud=$work/cache/$UBUNTU_SUITE-$UBUNTU_SERIAL-server-cloudimg-$arch.img
  download "$cloud" "https://cloud-images.ubuntu.com/$UBUNTU_SUITE/$UBUNTU_SERIAL/$UBUNTU_SUITE-server-cloudimg-$arch.img" "${!image_sha}"
  qemu-img convert -f qcow2 -O raw "$cloud" "$dir/disk.raw"
  truncate -s "$size" "$dir/disk.raw"

  cp "$here/image.env" "$here/provision.sh" "$here/seal.sh" "$dir/seed/"
  cat > "$dir/seed/user-data" <<'EOF'
#cloud-config
users: []
disable_root: true
ssh_pwauth: false
package_update: false
package_upgrade: false
growpart: { mode: auto, devices: ["/"] }
runcmd:
  - mkdir -p /run/paws-seed
  - mount -o ro /dev/disk/by-label/CIDATA /run/paws-seed
  - if sh /run/paws-seed/provision.sh /run/paws-seed/image.env; then systemd-run --no-block --unit paws-image-seal -p After=cloud-final.service /bin/sh /run/paws-seed/seal.sh; else systemctl --no-block poweroff; fi
EOF
  write_seed "$dir/seed" "$dir/seed.img"

  start_nat
  printf 'Building %s (%s, %s vCPU, %s); serial log in %s\n' "$image_name" "$UBUNTU_SERIAL" "$cpus" "$memory" "$dir/serial.log"
  boot "$dir/disk.raw" "$dir/seed.img" "$dir/serial.log"
  local status=0
  wait "$vm_pid" || status=$?
  vm_pid=""
  [ "$status" -ne 124 ] || { tail -n 40 "$dir/serial.log" >&2; die "The build VM did not power off within $timeout seconds"; }
  [ "$status" -eq 0 ] || { tail -n 40 "$dir/serial.log" >&2; die "Cloud Hypervisor exited with status $status"; }

  attach "$dir/disk.raw"
  rm -rf "$mounted/var/log/journal/"*
  find "$mounted/var/log" -type f -exec truncate -s 0 {} +
  if ! inspect "$mounted"; then
    detach
    tail -n 40 "$dir/serial.log" >&2
    die "The image was not sealed; see $dir/serial.log"
  fi
  detach

  cp --sparse=always "$dir/disk.raw" "$out/$image_name"
  (
    cd "$out"
    touch SHA256SUMS
    grep -v " \*\?$image_name\$" SHA256SUMS > SHA256SUMS.new || true
    sha256sum "$image_name" >> SHA256SUMS.new
    mv SHA256SUMS.new SHA256SUMS
  )
  rm -rf "$dir"
  printf 'Wrote %s and SHA256SUMS\n' "$out/$image_name"
}

check() {
  [ $# -ge 1 ] || { usage >&2; exit 1; }
  local image=$1 size=20G
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      --size) size=$2; shift 2 ;;
      *) usage >&2; exit 1 ;;
    esac
  done
  [ -f "$image" ] || die "No image at $image"
  local repo
  repo=$(git -C "$here" rev-parse --show-toplevel) || die "check runs knip on the paws-app checkout around $here, which is not a Git checkout"
  local sums
  sums=$(dirname "$image")/SHA256SUMS
  if [ -f "$sums" ]; then
    (cd "$(dirname "$image")" && grep " \*\?$(basename "$image")\$" SHA256SUMS | sha256sum -c --quiet -) || die "$image does not match SHA256SUMS"
  fi
  fetch_tools
  local dir=$work/check-$arch
  rm -rf "$dir"
  mkdir -p "$dir/seed"
  cp --sparse=always "$image" "$dir/disk.raw"
  attach "$dir/disk.raw"
  inspect "$mounted" || die "$image holds state from its build"
  detach
  truncate -s "$size" "$dir/disk.raw"
  ssh-keygen -q -t ed25519 -N '' -C paws-image-check -f "$dir/key"
  cat > "$dir/seed/user-data" <<EOF
#cloud-config
users:
  - name: paws
    groups: [docker]
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    shell: /bin/bash
    ssh_authorized_keys: [ "$(cat "$dir/key.pub")" ]
ssh_pwauth: false
EOF
  write_seed "$dir/seed" "$dir/seed.img"

  start_nat
  local started=$SECONDS
  boot "$dir/disk.raw" "$dir/seed.img" "$dir/serial.log"
  local ssh_options=(-i "$dir/key" -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$dir/known_hosts")
  until ssh "${ssh_options[@]}" "paws@$guest_ip" true 2>/dev/null; do
    kill -0 "$vm_pid" 2>/dev/null || { tail -n 40 "$dir/serial.log" >&2; die "The VM stopped before SSH answered"; }
    [ $((SECONDS - started)) -lt 300 ] || { tail -n 40 "$dir/serial.log" >&2; die "SSH did not answer within 300 seconds"; }
    sleep 2
  done
  printf 'SSH answered after %s seconds\n' "$((SECONDS - started))"
  ssh "${ssh_options[@]}" "paws@$guest_ip" bash -s <<'EOF'
set -euo pipefail
cloud-init status --wait >/dev/null || [ $? -eq 2 ]
id=$(cat /etc/machine-id)
[ -n "$id" ] && [ "$id" != uninitialized ]
ls /etc/ssh/ssh_host_ed25519_key.pub >/dev/null
[ ! -e /etc/paws-runner/config.json ]
[ -z "$(sudo ls -A /var/lib/paws-runner)" ]
docker run --rm busybox true
sudo runuser -u paws-agent -- docker --host unix:///run/paws-agent-docker/docker.sock info >/dev/null
kind create cluster --name paws-check --wait 180s
docker exec paws-check-control-plane kubectl get nodes
kind delete cluster --name paws-check
[ "$(cat /proc/sys/vm/overcommit_memory)" = 1 ]
EOF
  git -C "$repo" archive --format=tar HEAD | ssh "${ssh_options[@]}" "paws@$guest_ip" 'rm -rf paws-app && mkdir paws-app && tar -x -C paws-app'
  ssh "${ssh_options[@]}" "paws@$guest_ip" 'cd paws-app && /opt/paws-runner/bin/bun install --frozen-lockfile && /opt/paws-runner/bin/bun --bun run knip'
  ssh "${ssh_options[@]}" "paws@$guest_ip" sudo systemctl --no-block poweroff || true
  wait "$vm_pid" || true
  vm_pid=""
  rm -rf "$dir"
  printf '%s boots to SSH, runs Docker, a kind cluster and knip\n' "$image"
}

[ $# -ge 1 ] || { usage >&2; exit 1; }
command=$1
shift
case $command in
  -h|--help) usage; exit 0 ;;
  build|check) ;;
  *) usage >&2; exit 1 ;;
esac
[ "$(id -u)" -eq 0 ] || die "Run base-disk.sh as root: it creates a tap device, NAT rules and loop devices"
need curl git sha256sum qemu-img mkfs.vfat mcopy losetup nft ip sysctl timeout ssh ssh-keygen
"$command" "$@"
