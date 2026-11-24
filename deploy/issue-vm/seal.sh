#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Run seal.sh as root" >&2; exit 1; }
trap 'systemctl --no-block poweroff' EXIT

systemctl stop docker.service docker.socket containerd.service 2>/dev/null || true
systemctl stop paws-runner.service 2>/dev/null || true
loginctl terminate-user paws-agent 2>/dev/null || true

cloud-init clean --logs --seed --configs all --machine-id
rm -f /etc/ssh/ssh_host_*
rm -f /var/lib/systemd/random-seed /var/lib/systemd/credential.secret
[ -L /var/lib/dbus/machine-id ] || rm -f /var/lib/dbus/machine-id
find /var/lib/docker /var/lib/paws-agent-docker /var/lib/paws-runner-docker -name engine-id -type f -delete 2>/dev/null || true
rm -rf /var/lib/paws-runner/* /var/lib/paws-runner-spool/* /var/lib/paws-agent-tasks/* /var/lib/paws-agent-results/*
rm -f /etc/paws-runner/config.json
rm -rf /root/.ssh /root/.bash_history /root/.cache /root/.wget-hsts
for home in /home/*; do
  [ -d "$home" ] || continue
  rm -rf "$home/.ssh" "$home/.bash_history" "$home/.cache"
done
rm -f /etc/sudoers.d/90-cloud-init-users
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -rf /var/lib/dhcp/* /var/lib/systemd/network/* /var/lib/NetworkManager/*
rm -rf /tmp/* /tmp/.[!.]* /var/tmp/* /var/tmp/.[!.]*
journalctl --rotate >/dev/null 2>&1 || true
journalctl --vacuum-time=1s >/dev/null 2>&1 || true
rm -rf /var/log/journal/*
find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' \) -delete
find /var/log -type f -exec truncate -s 0 {} +

install -d -m 0755 /etc/paws-issue-vm
date -u +%Y-%m-%dT%H:%M:%SZ > /etc/paws-issue-vm/sealed
sync
fstrim -a >/dev/null 2>&1 || true
