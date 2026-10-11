const MIN_SECRET_LENGTH = 8;
const REDACTED = "[redacted]";

export function createStreamScrubber(secrets: readonly string[]): {
  push(chunk: string): string;
  flush(): string;
} {
  const usable = uniqueSecrets(secrets);
  let pending = "";
  let consumingToken = false;
  return {
    push(chunk) {
      if (consumingToken) {
        chunk = chunk.replace(/^[A-Za-z0-9_-]+/, "");
        if (chunk.length === 0) return "";
        consumingToken = false;
      }
      pending += chunk;
      pending = redact(pending, usable);
      for (const match of pending.matchAll(TOKEN_PATTERN)) {
        consumingToken = match.index + match[0].length === pending.length;
      }
      pending = redactTokens(pending);
      const hold = Math.max(secretPrefixLength(pending, usable), tokenPrefixLength(pending));
      if (hold === 0) {
        const emit = pending;
        pending = "";
        return emit;
      }
      if (hold >= pending.length) return "";
      const emit = pending.slice(0, pending.length - hold);
      pending = pending.slice(pending.length - hold);
      return emit;
    },
    flush() {
      const emit = redactTokens(redact(pending, usable));
      pending = "";
      if (emit.length >= MIN_SECRET_LENGTH && isProperPrefix(emit, usable)) return REDACTED;
      return emit;
    },
  };
}

export function scrubText(text: string, secrets: readonly string[]): string {
  const scrubber = createStreamScrubber(secrets);
  return scrubber.push(text) + scrubber.flush();
}

function uniqueSecrets(secrets: readonly string[]): string[] {
  const found = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    found.add(secret);
  }
  return [...found].sort((left, right) => right.length - left.length);
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out;
}

function secretPrefixLength(text: string, secrets: readonly string[]): number {
  const max = Math.min(
    text.length,
    secrets.reduce((longest, secret) => Math.max(longest, secret.length - 1), 0),
  );
  for (let length = max; length >= 1; length -= 1) {
    const suffix = text.slice(text.length - length);
    if (isProperPrefix(suffix, secrets)) return length;
  }
  return 0;
}

function isProperPrefix(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.startsWith(text) && text.length < secret.length);
}

const TOKEN_STARTS = [
  "github_pat_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "xoxr-",
  "xoxs-",
  "AKIA",
  "sk-",
];

const TOKEN_PATTERN =
  /github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}/g;

function redactTokens(text: string): string {
  return text.replace(TOKEN_PATTERN, REDACTED);
}

function tokenPrefixLength(text: string): number {
  const max = Math.min(text.length, 96);
  for (let length = max; length >= 1; length -= 1) {
    if (isTokenPrefix(text.slice(text.length - length))) return length;
  }
  return 0;
}

function isTokenPrefix(text: string): boolean {
  for (const start of TOKEN_STARTS) {
    if (start.startsWith(text) && text.length < start.length) return true;
    if (!text.startsWith(start)) continue;
    const rest = text.slice(start.length);
    if (!/^[A-Za-z0-9_-]*$/.test(rest)) continue;
    const minBody = start === "AKIA" ? 16 : start.startsWith("xox") ? 10 : 20;
    if (rest.length < minBody) return true;
  }
  return false;
}
