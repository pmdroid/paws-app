#!/bin/bash
set -euo pipefail
export LC_ALL=C

lib=${PAWS_ISSUE_VM_LIB:-/usr/local/lib/paws-issue-vm}
state=${PAWS_ISSUE_VM_STATE:-/var/lib/paws-issue-vm-state}
dev=${PAWS_ISSUE_VM_DEV:-/dev/paws-issue-vms}
user=paws-issue-vm
id_pattern='^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
live='active|activating|deactivating|reloading|refreshing'

die() {
  printf '%s\n' "$1" >&2
  exit 2
}

parse() {
  local extra
  IFS=- read -r id slot cpus memory extra <<<"$1"
  [[ -z $extra && $id =~ $id_pattern && $slot =~ ^[1-9][0-9]{0,2}$ && $cpus =~ ^[1-9][0-9]?$ && $memory =~ ^[1-9][0-9]{0,2}$ ]] ||
    die "Bad issue VM: $1"
  ((slot <= 254 && cpus <= 32 && memory <= 128)) || die "Issue VM out of range: $1"
  instance=$1
  dir=$state/$id
  disk=$dev/$id
  tap=pawsvm$slot
  host_ip=10.199.$slot.1
  guest_ip=10.199.$slot.2
}

others() {
  systemctl list-units --all --plain --no-legend --no-pager "paws-issue-vm@$1" |
    awk -v self="paws-issue-vm@$instance.service" -v live="^($live)\$" '$1 != self && $3 ~ live { print $1 }'
}

write_seed() {
  mkdir -p "$dir/seed"
  cat >"$dir/seed/meta-data" <<EOF
instance-id: $id
local-hostname: paws-vm-${id,,}
EOF
  cat >"$dir/seed/network-config" <<EOF
version: 2
ethernets:
  id0:
    match: { name: "en*" }
    addresses: [ "$guest_ip/24" ]
    routes: [ { to: default, via: "$host_ip" } ]
    nameservers: { addresses: [ "1.1.1.1", "9.9.9.9" ] }
EOF
  printf '#cloud-config\n{}\n' >"$dir/seed/user-data"
  rm -f "$dir/seed.img"
  truncate -s 8M "$dir/seed.img"
  mkfs.vfat -n CIDATA "$dir/seed.img" >/dev/null
  mcopy -o -i "$dir/seed.img" "$dir/seed"/* ::/
  chown "$user:$user" "$dir/seed.img"
  chmod 0400 "$dir/seed.img"
}

prepare() {
  [[ -e $disk ]] || die "No disk for $id at $disk"
  [[ -z $(others "$id-*") ]] || die "Issue VM $id already runs"
  [[ -z $(others "*-$slot-*-*") ]] || die "Slot $slot is taken"
  mkdir -p "$state"
  chmod 0711 "$state"
  mkdir -p "$dir"
  chown "$user:$user" "$dir"
  chmod 0700 "$dir"
  rm -f "$dir/api.sock"
  write_seed
  chown "$user" "$(readlink -f "$disk")"
  systemctl start "paws-issue-vm-network@$slot.service"
}

run() {
  exec "$lib/cloud-hypervisor" --kernel "$lib/firmware.fd" \
    --disk "path=$disk,image_type=raw" "path=$dir/seed.img,readonly=on,image_type=raw" \
    --cpus "boot=$cpus" --memory "size=${memory}G" \
    --net "tap=$tap,ip=$host_ip,mask=255.255.255.0,mac=52:54:00:c7:00:$(printf %02x "$slot")" \
    --serial "file=$dir/serial.log" --console off --api-socket "path=$dir/api.sock"
}

clean() {
  if [[ -z $(others "$id-*") ]]; then
    rm -f "$dir/api.sock"
    if [[ -e $disk ]]; then chown root "$(readlink -f "$disk")"; fi
  fi
  if [[ -z $(others "*-$slot-*-*") ]]; then systemctl stop "paws-issue-vm-network@$slot.service"; fi
}

case "${1:-}" in
prepare | run | clean)
  parse "${2:-}"
  "$1"
  ;;
*)
  printf '%s\n' "Usage: vm.sh prepare|run|clean ID-SLOT-VCPUS-MEMORY_GB" >&2
  exit 2
  ;;
esac
