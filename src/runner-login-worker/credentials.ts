import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

type Agent = "claude" | "codex" | "grok" | "opencode";

/**
 * Files a sign-in writes, relative to the home. `merge` files hold the agent's own state too,
 * so only the account keys move over to the live file.
 */
const CREDENTIALS: Record<Agent, { path: string; merge?: readonly string[] }[]> = {
  claude: [
    { path: ".claude/.credentials.json" },
    { path: ".claude/.claude.json", merge: ["oauthAccount"] },
  ],
  codex: [{ path: ".codex/auth.json" }],
  grok: [{ path: ".grok/auth.json" }],
  opencode: [{ path: ".local/share/opencode/auth.json" }],
};

/**
 * A fresh home on the live home's filesystem for the provider to sign in to. Running turns keep
 * reading the live credentials until {@link publishCredentials} renames the new ones over them.
 */
export function stageLoginHome(home: string): string {
  const staged = join(home, `.paws-login-${randomUUID()}`);
  mkdirSync(staged, { mode: 0o700 });
  for (const directory of [".claude", ".codex", ".grok", ".local/share/opencode"])
    mkdirSync(join(staged, directory), { recursive: true, mode: 0o700 });
  return staged;
}

export function discardLoginHome(staged: string): void {
  rmSync(staged, { recursive: true, force: true });
}

/**
 * Moves a confirmed sign-in into the live home. Each file is written whole to a temporary file
 * beside its target and renamed over it, so a reader sees the old file or the new one.
 */
export function publishCredentials(agent: Agent, staged: string, home: string): void {
  let published = 0;
  for (const file of CREDENTIALS[agent]) {
    const source = read(join(staged, file.path));
    if (source === null) continue;
    const target = join(home, file.path);
    let data = source;
    if (file.merge) {
      const live = read(target);
      if (live !== null) data = mergeKeys(live, source, file.merge);
    }
    replaceFile(target, data);
    published += 1;
  }
  if (published === 0) throw new Error("Provider did not write credentials");
}

function read(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function mergeKeys(live: Buffer, staged: Buffer, keys: readonly string[]): Buffer {
  const current = object(live);
  const next = object(staged);
  if (!current || !next) return staged;
  for (const key of keys) {
    if (key in next) current[key] = next[key];
    else delete current[key];
  }
  return Buffer.from(`${JSON.stringify(current, null, 2)}\n`);
}

function object(data: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function replaceFile(target: string, data: Buffer): void {
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.paws-login`);
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeSync(descriptor, data);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  const parent = openSync(directory, "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
