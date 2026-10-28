import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validatePublicTlsFiles } from "../deployment";
import { UNIT_NAME } from "./files";

export const TLS_DIR = "tls";
export const RENEW_SERVICE = "paws-tls-renew.service";
export const RENEW_TIMER = "paws-tls-renew.timer";
const SYSTEMCTL = "/usr/bin/systemctl";

export type TlsPaths = { key: string; cert: string };

/** The public URL's host when it is a tailnet name (`*.ts.net`), else null. */
export function tailnetHost(publicUrl: string): string | null {
  if (!publicUrl) return null;
  const host = new URL(publicUrl).hostname.toLowerCase();
  return host.endsWith(".ts.net") ? host : null;
}

/** Where `tailscale cert` writes for `host`: `PAWS_HOME/tls/<host>.key` and `.crt`. */
export function tailnetTlsPaths(pawsHome: string, host: string): TlsPaths {
  const dir = join(pawsHome, TLS_DIR);
  return { key: join(dir, `${host}.key`), cert: join(dir, `${host}.crt`) };
}

function certCommand(tailscale: string, host: string, paths: TlsPaths): string[] {
  return [tailscale, "cert", "--cert-file", paths.cert, "--key-file", paths.key, host];
}

/**
 * Runs `tailscale cert` into `paths` with the key at 0600. Returns null on success,
 * or what went wrong and the commands to run by hand.
 */
export async function fetchTailnetCert(
  tailscale: string | null,
  host: string,
  paths: TlsPaths,
): Promise<string | null> {
  let failure: string;
  if (tailscale === null) failure = "The tailscale CLI is not on PATH.";
  else {
    mkdirSync(dirname(paths.key), { recursive: true, mode: 0o700 });
    try {
      const child = Bun.spawn(certCommand(tailscale, host, paths), {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      if (code === 0 && existsSync(paths.key) && existsSync(paths.cert)) {
        chmodSync(paths.key, 0o600);
        chmodSync(paths.cert, 0o644);
        return null;
      }
      const detail = stderr.trim().split("\n").slice(-3).join(" ").trim();
      failure = `tailscale cert ${host} exited ${code}${detail ? `: ${detail}` : "."}`;
    } catch (error) {
      failure = `tailscale cert ${host} could not run: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return [
    failure,
    "It needs the tailscale CLI, HTTPS certificates turned on for the tailnet (admin console, DNS page),",
    "and permission for this user to fetch certificates. Run these, then run paws install again:",
    "  sudo tailscale set --operator=$USER",
    `  ${certCommand("tailscale", host, paths).join(" ")}`,
    `  chmod 600 ${paths.key}`,
  ].join("\n");
}

/** Returns certificate validation errors without loading unrelated runtime settings. */
export function checkTls(input: { publicUrl: string; paths: TlsPaths }): string | null {
  try {
    validatePublicTlsFiles({
      PAWS_PUBLIC_DASHBOARD: "1",
      PAWS_PUBLIC_URL: input.publicUrl,
      PAWS_TLS_KEY_PATH: input.paths.key,
      PAWS_TLS_CERT_PATH: input.paths.cert,
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

/** Escape systemd specifiers and environment expansion in ExecStart arguments. */
function unitArg(value: string): string {
  return value.replaceAll("%", "%%").replaceAll("$", () => "$$");
}

/** Mirrors `deploy/linux/renew-public-tls.py`: renew, then reload Paws (SIGHUP, exit 75). */
export function renderRenewService(input: {
  tailscale: string;
  host: string;
  paths: TlsPaths;
}): string {
  return [
    "[Unit]",
    "Description=Renew the Paws tailnet HTTPS certificate",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${certCommand(input.tailscale, input.host, input.paths).map(unitArg).join(" ")}`,
    `ExecStartPost=/bin/chmod 0600 ${unitArg(input.paths.key)}`,
    `ExecStartPost=${SYSTEMCTL} --user try-reload-or-restart ${UNIT_NAME}`,
    "",
  ].join("\n");
}

export function renderRenewTimer(): string {
  return [
    "[Unit]",
    "Description=Renew the Paws tailnet HTTPS certificate weekly",
    "",
    "[Timer]",
    "OnCalendar=weekly",
    "RandomizedDelaySec=1h",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

/** The tailnet policy rule from `docs/create-vm.md` for the dashboard and runner ports. */
export function aclLines(port: number, runnerPort: number | null): string[] {
  if (runnerPort === null)
    return [`The public dashboard uses port ${port}; the runner listener is disabled.`];
  return [
    `Runner VMs on the tailnet reach Paws on ${port} (enrollment) and ${runnerPort} (runner mTLS).`,
    "In the tailnet policy file, with paws as the Paws machine's host alias (docs/create-vm.md):",
    `  "acls": [{ "action": "accept", "src": ["tag:paws-runner"], "dst": ["paws:${port},${runnerPort}"] }]`,
    `  or with grants: { "src": ["tag:paws-runner"], "dst": ["paws"], "ip": ["tcp:${port}", "tcp:${runnerPort}"] }`,
  ];
}

/**
 * Writes a fake `tailscale` command into `dir` that copies `source` for `cert` and
 * appends each host to `dir/calls`. Exits `code` without copying when non-zero.
 */
export function fakeTailscale(dir: string, source: TlsPaths, code = 0): string {
  const script = join(dir, "tailscale");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      '[ "$1" = cert ] || exit 2',
      "shift",
      'while [ $# -gt 1 ]; do case "$1" in',
      "  --cert-file) cert=$2; shift 2 ;;",
      "  --key-file) key=$2; shift 2 ;;",
      "  *) exit 2 ;;",
      "esac; done",
      `echo "$1" >> '${join(dir, "calls")}'`,
      code === 0 ? "" : `echo 'certificates are not enabled for this tailnet' >&2; exit ${code}`,
      `cp '${source.cert}' "$cert" && cp '${source.key}' "$key" && chmod 644 "$key"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return script;
}
