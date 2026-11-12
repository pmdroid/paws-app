import { isIP } from "node:net";
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { EnvSource } from "../config";

export type PublicTls = { key: string; cert: string };

export function loadPublicTls(source: EnvSource): PublicTls | undefined {
  const keyPath = source.PAWS_TLS_KEY_PATH?.trim();
  const certPath = source.PAWS_TLS_CERT_PATH?.trim();
  if (!keyPath && !certPath) {
    if (source.PAWS_PUBLIC_DASHBOARD === "1")
      throw new Error("Public dashboard requires PAWS_TLS_KEY_PATH and PAWS_TLS_CERT_PATH");
    return undefined;
  }
  return readTlsPair(keyPath, certPath, "PAWS_TLS", "Public");
}

function readTlsPair(
  keyPath: string | undefined,
  certPath: string | undefined,
  variable: string,
  label: string,
): PublicTls {
  if (!keyPath || !certPath || !isAbsolute(keyPath) || !isAbsolute(certPath))
    throw new Error(`${variable}_KEY_PATH and ${variable}_CERT_PATH must both be absolute paths`);
  const keyFile = statSync(keyPath);
  if (!keyFile.isFile() || ![0o400, 0o600].includes(keyFile.mode & 0o777))
    throw new Error(
      `${label} TLS private key must be an owner-only readable file: chmod 600 ${keyPath}`,
    );
  const key = readFileSync(keyPath, "utf8");
  const cert = readFileSync(certPath, "utf8");
  try {
    const certificate = new X509Certificate(cert);
    if (!certificate.publicKey.equals(createPublicKey(createPrivateKey(key))))
      throw new Error("mismatched");
    if (certificate.keyUsage && !certificate.keyUsage.includes("1.3.6.1.5.5.7.3.1"))
      throw new Error("unsupported server purpose");
    const now = Date.now();
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (validFrom > now) throw new Error(`not valid until ${certificate.validFrom}`);
    if (validTo <= now) throw new Error(`expired on ${certificate.validTo}`);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo))
      throw new Error("invalid validity dates");
  } catch (error) {
    throw new Error(
      `${label} TLS certificate and private key must be valid and match: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return { key, cert };
}

export function publicTlsProxy(source: EnvSource): boolean {
  const mode = source.PAWS_PUBLIC_TLS?.trim();
  if (!mode) return false;
  if (mode !== "proxy") throw new Error("PAWS_PUBLIC_TLS must be proxy or unset");
  if (source.PAWS_TLS_KEY_PATH?.trim() || source.PAWS_TLS_CERT_PATH?.trim())
    throw new Error("PAWS_PUBLIC_TLS=proxy does not use PAWS_TLS_KEY_PATH or PAWS_TLS_CERT_PATH");
  return true;
}

export const PROXY_RUNNER_TLS_REQUIRED =
  "PAWS_PUBLIC_TLS=proxy needs PAWS_RUNNER_URL, PAWS_RUNNER_TLS_KEY_PATH and PAWS_RUNNER_TLS_CERT_PATH for runner control";

export function loadRunnerTls(
  control: { url: string | null; tls: { keyPath: string; certPath: string } | null },
  publicTls: PublicTls | undefined,
  proxy: boolean,
): PublicTls {
  if (proxy && (control.url === null || control.tls === null))
    throw new Error(PROXY_RUNNER_TLS_REQUIRED);
  const tls = control.tls
    ? readTlsPair(control.tls.keyPath, control.tls.certPath, "PAWS_RUNNER_TLS", "Runner")
    : publicTls;
  if (tls === undefined) throw new Error(PROXY_RUNNER_TLS_REQUIRED);
  if (control.url !== null && !certificateCovers(tls.cert, control.url))
    throw new Error(
      `Runner HTTPS certificate does not cover ${new URL(control.url).hostname} from PAWS_RUNNER_URL.`,
    );
  return tls;
}

export function certificateCovers(cert: string, origin: string): boolean {
  const certificate = new X509Certificate(cert);
  const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  return (
    (isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname)) !== undefined
  );
}
