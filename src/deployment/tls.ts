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
  if (!keyPath || !certPath || !isAbsolute(keyPath) || !isAbsolute(certPath))
    throw new Error("PAWS_TLS_KEY_PATH and PAWS_TLS_CERT_PATH must both be absolute paths");
  const keyFile = statSync(keyPath);
  if (!keyFile.isFile() || ![0o400, 0o600].includes(keyFile.mode & 0o777))
    throw new Error("Public TLS private key must be an owner-only readable file");
  const key = readFileSync(keyPath, "utf8");
  const cert = readFileSync(certPath, "utf8");
  try {
    const certificate = new X509Certificate(cert);
    if (!certificate.publicKey.equals(createPublicKey(createPrivateKey(key))))
      throw new Error("mismatched");
    const now = Date.now();
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (
      !Number.isFinite(validFrom) ||
      !Number.isFinite(validTo) ||
      validFrom > now ||
      validTo <= now
    )
      throw new Error("expired");
  } catch {
    throw new Error("Public TLS certificate and private key must be valid and match");
  }
  return { key, cert };
}
