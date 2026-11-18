set -eu

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  printf 'Usage: sudo sh %s owner/repository [runner-name]\n' "$0" >&2
  exit 1
fi

repository=$1
runner_name=${2:-$(hostname -s)}

if ! printf '%s\n' "$repository" | LC_ALL=C grep -Eq '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'; then
  printf '%s\n' 'Repository must use owner/repository format.' >&2
  exit 1
fi

if [ "$(uname -s)" != Linux ] || [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Run this script with sudo sh on the Linux runner VM.' >&2
  exit 1
fi

if [ -e /etc/paws-runner/config.json ] || [ -L /etc/paws-runner/config.json ]; then
  printf '%s\n' '/etc/paws-runner/config.json already exists. Use the runner pairing guide to update this host.' >&2
  exit 1
fi

control_plane_url=https://agentbox.taile07e4.ts.net:8787
runner_api_url=https://agentbox.taile07e4.ts.net:8788

printf '%s\n' 'Checking Paws connectivity through Tailscale.'
curl --fail --silent --show-error --connect-timeout 10 --max-time 30 "$control_plane_url/health"
printf '\n'

if [ ! -x /opt/paws-runner/bin/paws-runner ]; then
  installer=$(mktemp)
  trap 'rm -f "$installer"' 0
  curl --fail --silent --show-error --location https://get.paws.boo -o "$installer"
  sh "$installer"
fi

install -o root -g paws-runner -m 0640 /dev/stdin /etc/paws-runner/config.json <<JSON
{
  "controlPlaneUrl": "$control_plane_url",
  "runnerApiUrl": "$runner_api_url",
  "allowedRepositories": ["$repository"],
  "concurrency": 2
}
JSON

printf '\nOpen %s/status/runners and select Pair a host.\n' "$control_plane_url"
printf '%s\n' 'Enter the code printed below, compare the fingerprint, and approve the runner.'

/usr/sbin/runuser --user paws-runner -- \
  /usr/bin/env -i --chdir=/var/lib/paws-runner \
  HOME=/var/lib/paws-runner PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C \
  /opt/paws-runner/bin/paws-runner runner pair \
  --config /etc/paws-runner/config.json --name "$runner_name"

systemctl enable --now paws-runner.service
systemctl status paws-runner.service --no-pager

printf '\nOpen %s/status/runners and select Sign in to agents for this runner.\n' "$control_plane_url"
