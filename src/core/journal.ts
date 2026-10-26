let sink: (line: string) => void = (line) => console.error(line);

export function journal(line: string): void {
  sink(line);
}

export function setJournalSink(next: (line: string) => void): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

export function journalCaught(
  error: unknown,
  operation: string,
  itemId: string | null | undefined = null,
  expected?: string,
  write: (line: string) => void = journal,
): void {
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof SyntaxError) message = message.replace(/"[^"\n]*"/g, '"[redacted input]"');
  if (typeof process !== "undefined") {
    for (const [key, secret] of Object.entries(process.env))
      if (/KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL/i.test(key) && secret && secret.length >= 8)
        message = message.replaceAll(secret, "[redacted]");
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (expected === "optional file may be absent" && code !== "ENOENT" && code !== "ENOTDIR")
    expected = undefined;
  if (
    expected === "process may be absent or inaccessible" &&
    !["ENOENT", "ENOTDIR", "ESRCH", "EACCES", "EPERM"].includes(String(code))
  )
    expected = undefined;
  if (expected === "path may already exist" && code !== "EEXIST") expected = undefined;
  if (
    expected === "process may have exited" &&
    !["ESRCH", "ENOENT", "ENOTDIR"].includes(String(code))
  )
    expected = undefined;
  if (
    expected === "cancellation may interrupt work" &&
    !(error instanceof Error && error.name === "AbortError") &&
    code !== "ABORT_ERR"
  )
    expected = undefined;
  if (expected === "prerequisite may be absent" && code !== "ENOENT") expected = undefined;
  write(
    `catch item=${oneLine(itemId ?? "none")} operation=${oneLine(operation)}${expected ? ` expected=${oneLine(expected)}` : ""}${typeof code === "string" ? ` code=${oneLine(code)}` : ""} error=${oneLine(message)}`,
  );
}

function oneLine(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[redacted key]",
    )
    .replace(
      /github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|lin_api_[A-Za-z0-9]+/g,
      "[redacted token]",
    )
    .replace(/\b(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@")
    .replace(
      /([?&](?:token|key|secret|signature|password|credential|access_token)=)[^\s&#]+/gi,
      "$1[redacted]",
    )

    .replace(/[\s\S]/gu, (char) =>
      char.charCodeAt(0) < 32 ||
      char.charCodeAt(0) === 127 ||
      char === "\u2028" ||
      char === "\u2029"
        ? " "
        : char,
    )
    .slice(0, 1_000);
}

export function journalRejection<E, T>(
  operation: string,
  handler: (error: E) => T,
  itemId: string | null | undefined = null,
): (error: E) => T {
  return (error) => {
    journalCaught(error, operation, itemId);
    return handler(error);
  };
}

export function journalItemId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("itemId" in payload)) return null;
  return typeof payload.itemId === "string" ? payload.itemId : null;
}
