#!/bin/bash
set -euo pipefail
export LC_ALL=C

dir=/var/lib/paws-runner/issue-vms
image=$dir/pool.img
vg=paws-issue-vms
out=${PAWS_ISSUE_VM_DISK_OUT:-/run/paws-issue-vm-disk}
id_pattern='^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
gib=1073741824

die() {
  printf '%s\n' "$1" >&2
  exit 2
}

usage() {
  printf '%s\n' "Usage: disk.sh init POOL_GB BASE_IMAGE" \
    "       disk.sh attach" \
    "       disk.sh run pool|list|create-ID-GB|delete-ID" \
    "Keeps one thin disk per issue VM in the LVM thin pool on $image."
}

attach() {
  [[ -f $image && ! -L $image ]] || die "No pool image at $image"
  if [[ -z $(losetup -n -O NAME -j "$image") ]]; then
    losetup -f "$image"
    pvscan -q --cache >/dev/null 2>&1 || true
  fi
  vgchange -q -ay "$vg" >/dev/null
}

init() {
  [[ ${1:-} =~ ^[1-9][0-9]*$ && -f ${2:-} ]] || {
    usage >&2
    exit 2
  }
  [[ ! -e $image ]] || die "$image already exists"
  local mib=$((($(stat -c %s "$2") + 4194303) / 4194304 * 4))
  install -d -m 0700 "$dir"
  truncate -s "${1}G" "$image"
  vgcreate -q "$vg" "$(losetup -f --show "$image")" >/dev/null
  lvcreate -q -l 95%FREE -T "$vg/pool" >/dev/null
  lvcreate -q -V "${mib}m" -T "$vg/pool" -n base >/dev/null
  dd if="$2" of="/dev/$vg/base" bs=4M conv=sparse,fsync status=none
  lvchange -q -pr "$vg/base"
}

lv_bytes() {
  lvs --noheadings --units b --nosuffix -o lv_size "$vg/$1" | tr -d ' '
}

operate() {
  local op=$1
  case "$op" in
  pool)
    lvs --noheadings --units b --nosuffix --separator ' ' -o lv_size,data_percent "$vg/pool" |
      awk '{ printf "%d %d\n", $1, $1 * $2 / 100 }'
    ;;
  list)
    lvs --noheadings --units b --nosuffix --separator ' ' -o lv_name,lv_size "$vg" |
      awk -v p="$id_pattern" '$1 ~ p { print $1, $2 }'
    ;;
  create-*)
    local rest=${op#create-}
    local id=${rest%-*} gb=${rest##*-}
    [[ $id =~ $id_pattern && $gb =~ ^[1-9][0-9]{1,2}$ ]] || die "Bad create: $op"
    ((gb >= 10 && gb <= 500)) || die "Disk size must be 10 to 500 GB: $gb"
    lvs "$vg/$id" >/dev/null 2>&1 || lvcreate -q -s -K -n "$id" "$vg/base" >/dev/null
    if (($(lv_bytes "$id") < gb * gib)); then lvextend -q -L "${gb}g" "$vg/$id" >/dev/null; fi
    lvchange -q -ay -K "$vg/$id"
    printf '%s\n' "/dev/$vg/$id"
    ;;
  delete-*)
    local id=${op#delete-}
    [[ $id =~ $id_pattern ]] || die "Bad delete: $op"
    if lvs "$vg/$id" >/dev/null 2>&1; then lvremove -q -y "$vg/$id" >/dev/null; fi
    ;;
  *) die "Unknown operation: $op" ;;
  esac
}

run() {
  local op=${1:-}
  [[ $op =~ ^(pool|list|create-[0-9A-Z]{26}-[0-9]+|delete-[0-9A-Z]{26})$ ]] || die "Unknown operation: $op"
  install -d -m 0750 -g paws-runner "$out"
  local result
  result=$(operate "$op")
  printf '%s\n' "$result" >"$out/$op.tmp"
  chgrp paws-runner "$out/$op.tmp"
  chmod 0640 "$out/$op.tmp"
  mv -f "$out/$op.tmp" "$out/$op.out"
}

case "${1:-}" in
init) init "${2:-}" "${3:-}" ;;
attach) attach ;;
run) run "${2:-}" ;;
*)
  usage >&2
  exit 2
  ;;
esac
