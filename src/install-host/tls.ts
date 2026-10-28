import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { validatePublicTls } from "../deployment";
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
        stdout: "pipe",
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

/**
 * Checks the pair with the same rules Paws applies at startup (`public-tls validate`),
 * plus the runner host. Returns null when valid, else what is wrong in plain words.
 */
export function checkTls(input: {
  pawsHome: string;
  publicUrl: string;
  runnerHost: string;
  paths: TlsPaths;
}): string | null {
  const { key, cert } = input.paths;
  if (!existsSync(key)) return `There is no key file at ${key}.`;
  if (!existsSync(cert)) return `There is no certificate file at ${cert}.`;
  const mode = statSync(key).mode & 0o777;
  if (![0o400, 0o600].includes(mode))
    return `The key ${key} has mode 0${mode.toString(8)}. Paws only reads an owner-only key: chmod 600 ${key}`;
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(readFileSync(cert));
  } catch {
    return `${cert} is not a PEM certificate.`;
  }
  const now = Date.now();
  if (Date.parse(certificate.validTo) <= now)
    return `The certificate ${cert} expired on ${certificate.validTo}.`;
  if (Date.parse(certificate.validFrom) > now)
    return `The certificate ${cert} is not valid until ${certificate.validFrom}.`;
  const names = certificate.subjectAltName ?? certificate.subject;
  for (const host of [new URL(input.publicUrl).hostname, input.runnerHost]) {
    const bare = host.replace(/^\[|\]$/g, "");
    if (!bare) continue;
    const matched = isIP(bare) ? certificate.checkIP(bare) : certificate.checkHost(bare);
    if (matched === undefined) return `The certificate is for ${names}, not ${bare}.`;
  }
  try {
    validatePublicTls({
      PAWS_HOME: input.pawsHome,
      PAWS_PUBLIC_DASHBOARD: "1",
      PAWS_PUBLIC_URL: input.publicUrl,
      PAWS_TLS_KEY_PATH: key,
      PAWS_TLS_CERT_PATH: cert,
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
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
    `ExecStart=${certCommand(input.tailscale, input.host, input.paths).join(" ")}`,
    `ExecStartPost=/bin/chmod 0600 ${input.paths.key}`,
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
export function aclLines(port: number, runnerPort: number): string[] {
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
