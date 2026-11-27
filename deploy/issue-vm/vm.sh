#!/bin/bash
set -euo pipefail
export LC_ALL=C

lib=${PAWS_ISSUE_VM_LIB:-/usr/local/lib/paws-issue-vm}
state=${PAWS_ISSUE_VM_STATE:-/var/lib/paws-issue-vm-state}
dev=${PAWS_ISSUE_VM_DEV:-/dev/paws-issue-vms}
enroll=${PAWS_ISSUE_VM_ENROLL:-/var/lib/paws-runner/issue-vm-enroll}
config=${PAWS_ISSUE_VM_CONFIG:-/etc/paws-runner/config.json}
proc=${PAWS_ISSUE_VM_PROC:-/proc}
network=${PAWS_ISSUE_VM_NETWORK:-/opt/paws-runner/current/deploy/linux/issue-vm-network.py}
checks=${PAWS_ISSUE_VM_CHECKS:-/run/paws-issue-vm-sleep-check}
check_port=7101
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
  seed=$state/seed-$id
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
  mkdir -p -m 0700 "$seed"
  cat >"$seed/meta-data" <<EOF
instance-id: $id-$slot
local-hostname: paws-vm-${id,,}
EOF
  cat >"$seed/network-config" <<EOF
version: 2
ethernets:
  id0:
    match: { name: "en*" }
    addresses: [ "$guest_ip/24" ]
    routes: [ { to: default, via: "$host_ip" } ]
    nameservers: { addresses: [ "1.1.1.1", "9.9.9.9" ] }
EOF
  user_data >"$seed/user-data"
  rm -f "$seed.img"
  truncate -s 8M "$seed.img"
  mkfs.vfat -n CIDATA "$seed.img" >/dev/null
  mcopy -o -i "$seed.img" "$seed"/* ::/
  rm -rf "$seed"
  chown "root:$user" "$seed.img"
  chmod 0440 "$seed.img"
}

user_data() {
  local staged=$enroll/$id token=
  if [[ -e $staged || -L $staged ]]; then
    if [[ -f $staged && ! -L $staged ]]; then token=$(head -c 300 "$staged"); fi
    rm -f "$staged"
  fi
  if [[ ! $token =~ ^[A-Za-z0-9_-]{16,256}$ || ! -f $config || -L $config ]]; then
    printf '#cloud-config\n{}\n'
    return
  fi
  local hosts
  hosts=$(python3 -I -B "$network" hosts "$config" | grep -E '^10\.199\.0\.[0-9]+ [a-z0-9.-]+$' | sed 's/^/      /') || hosts=
  cat <<EOF
#cloud-config
write_files:
  - path: /etc/paws-runner/config.json
    encoding: b64
    content: $(base64 -w0 "$config")
    owner: root:paws-runner
    permissions: "0640"
  - path: /var/lib/paws-bootstrap/enrollment-token
    encoding: b64
    content: $(printf '%s' "$token" | base64 -w0)
    owner: root:root
    permissions: "0600"
  - path: /etc/hosts
    append: true
    content: |
$hosts
runcmd:
  - [sh, -c, "code=1; for try in \$(seq 40); do /opt/paws-runner/bin/paws-runner runner enroll --config /etc/paws-runner/config.json --name paws-vm-${id,,} --token-file /var/lib/paws-bootstrap/enrollment-token && code=0 && break; sleep 15; done; rm -f /var/lib/paws-bootstrap/enrollment-token; [ \$code -eq 0 ] && systemctl enable --now paws-runner.service"]
EOF
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
  rm -f "$dir/api.sock" "$dir/vsock.sock"
  write_seed
  chown "$user" "$(readlink -f "$disk")"
  systemctl start "paws-issue-vm-network@$slot.service"
}

run() {
  exec "$lib/cloud-hypervisor" --kernel "$lib/firmware.fd" \
    --disk "path=$disk,image_type=raw" "path=$seed.img,readonly=on,image_type=raw" \
    --cpus "boot=$cpus" --memory "size=${memory}G" \
    --net "tap=$tap,ip=$host_ip,mask=255.255.255.0,mac=52:54:00:c7:00:$(printf %02x "$slot")" \
    --vsock "cid=3,socket=$dir/vsock.sock" \
    --serial "file=$dir/serial.log" --console off --api-socket "path=$dir/api.sock"
}

clean() {
  if [[ -z $(others "$id-*") ]]; then
    rm -f "$dir/api.sock" "$dir/vsock.sock"
    rm -rf "$seed" "$seed.img"
    if [[ -e $disk ]]; then chown root "$(readlink -f "$disk")"; fi
  fi
  if [[ -z $(others "*-$slot-*-*") ]]; then systemctl stop "paws-issue-vm-network@$slot.service"; fi
}

unseed() {
  local pid=${MAINPID:-} fd
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 0
  for _ in $(seq 600); do
    for fd in "$proc/$pid/fd/"*; do
      if [[ $(readlink "$fd" 2>/dev/null) == "$seed.img" ]]; then
        rm -f "$seed.img"
        return 0
      fi
    done
    [[ -d $proc/$pid ]] || return 0
    sleep 0.1
  done
}

ask_guest() {
  python3 -I -B -c '
import os, socket, sys

try:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(50)
        os.chdir(os.path.dirname(sys.argv[1]))
        s.connect(os.path.basename(sys.argv[1]))
        s.sendall(b"CONNECT %d\n" % int(sys.argv[2]))
        data = b""
        while len(data) < 65536:
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
except OSError as error:
    sys.exit("The VM did not answer the sign-in check: %s" % (error.strerror or error))
head, _, rest = data.partition(b"\n")
if not head.startswith(b"OK "):
    sys.exit("The VM did not answer the sign-in check")
lines = rest.decode("utf-8", "replace").strip().split("\n")
last = lines.pop() if lines[-1].startswith("paws-sleep-check-exit=") else ""
said = " ".join(line.strip() for line in lines if line.strip())
if not last:
    sys.exit(said or "The sign-in check in the VM did not finish")
if said:
    print(said)
sys.exit(0 if last == "paws-sleep-check-exit=0" else 1)
' "$dir/vsock.sock" "$check_port"
}

sleep_check() {
  local out=$checks/$instance.out text code=0
  mkdir -p "$checks"
  rm -f "$out"
  if [[ -z $(systemctl list-units --all --plain --no-legend --no-pager "paws-issue-vm@$instance.service" |
    awk -v live="^($live)\$" '$3 ~ live { print $1 }') ]]; then
    text="Issue VM $instance is not running"
    code=1
  else
    text=$(ask_guest 2>&1) || code=$?
  fi
  if [[ $code -ne 0 && -z $text ]]; then text="The sign-in check in the VM failed"; fi
  printf '%s\n' "${text:0:300}" >"$out.tmp"
  chmod 0644 "$out.tmp"
  mv -f "$out.tmp" "$out"
  if [[ -n $text ]]; then printf '%s\n' "$text" >&2; fi
  return "$code"
}

case "${1:-}" in
prepare | run | unseed | clean | sleep-check)
  parse "${2:-}"
  "${1/-/_}"
  ;;
*)
  printf '%s\n' "Usage: vm.sh prepare|run|unseed|clean|sleep-check ID-SLOT-VCPUS-MEMORY_GB" >&2
  exit 2
  ;;
esac
