function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const RUNNER_RELEASES = "https://github.com/pmdroid/paws-app/releases";

const MERGE_CONFIG =
  'import json,sys; p="/etc/paws-runner/config.json"; c=json.load(open(p)); c.update(json.loads(sys.argv[1])); open(p,"w").write(json.dumps(c,indent=2)+"\\n")';

/**
 * The one command a member runs on a fresh Linux host: install the runner, write its config for
 * this Paws, stage the token in a root-owned mode 0600 file, enroll and start the daemon. The
 * token reaches the file through the shell's printf builtin, never through a process's argv.
 * Docker for agent jobs is granted or denied explicitly, so the installer never needs a terminal
 * to ask.
 */
export function hostEnrollmentCommand(
  enrollment: { token: string; name: string; config: object },
  docker: boolean,
): string {
  const config = JSON.stringify(enrollment.config);
  return [
    `tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' ${RUNNER_RELEASES}/latest)`,
    'deb="paws-runner_${tag##*/v}_$(dpkg --print-architecture).deb"',
    'cd "$(mktemp -d)"',
    `curl -fsSL -O "${RUNNER_RELEASES}/download/\${tag##*/}/$deb" -O "${RUNNER_RELEASES}/download/\${tag##*/}/$deb.sha256"`,
    'sha256sum --check "$deb.sha256"',
    "sudo apt-get update",
    ...(docker
      ? [
          "{ ! command -v dockerd >/dev/null || sudo apt-get install -y rootlesskit uidmap slirp4netns dbus-user-session; }",
        ]
      : []),
    `sudo env DEBIAN_FRONTEND=noninteractive PAWS_RUNNER_DOCKER_ACCESS=${docker ? "grant" : "deny"} apt-get install -y --reinstall "./$deb"`,
    `printf '%s\\n' ${shellQuote(enrollment.token)} | sudo install -o root -g root -m 0600 /dev/stdin /etc/paws-runner/enrollment-token`,
    `if sudo test -e /etc/paws-runner/config.json; then sudo python3 -I -c ${shellQuote(MERGE_CONFIG)} ${shellQuote(config)}; else printf '%s\\n' ${shellQuote(config)} | sudo install -o root -g paws-runner -m 0640 /dev/stdin /etc/paws-runner/config.json; fi`,
    `sudo /opt/paws-runner/bin/paws-runner runner enroll --config /etc/paws-runner/config.json --name ${shellQuote(enrollment.name)} --token-file /etc/paws-runner/enrollment-token`,
    "sudo rm -f /etc/paws-runner/enrollment-token",
    "sudo systemctl enable --now paws-runner.service",
  ].join(" && \\\n  ");
}
