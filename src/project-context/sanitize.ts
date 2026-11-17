import { createHash } from "node:crypto";

const SECRETS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]"],
  [/\blin_(api|oauth|wh)_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@"],
  [/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "$1: [redacted]"],
];

const CODE_FENCE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g;

export function sanitizedContextText(text: string, maxBytes: number): string {
  let clean = text.replace(CODE_FENCE, "$1[code omitted]");
  for (const [pattern, replacement] of SECRETS) clean = clean.replace(pattern, replacement);
  clean = clean.replace(/\r\n/g, "\n").trim();
  while (Buffer.byteLength(clean, "utf8") > maxBytes)
    clean = clean.slice(
      0,
      Math.floor((clean.length * maxBytes) / Buffer.byteLength(clean, "utf8")) - 1,
    );
  return clean;
}

export function contextKey(prefix: string, text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return `${prefix}:${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}
