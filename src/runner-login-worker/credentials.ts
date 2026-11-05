import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

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
  for (const directory of [
    ".claude",
    ".codex",
    ".grok",
    ".config",
    ".local",
    ".local/share",
    ".local/state",
    ".cache",
  ])
    mkdirSync(join(staged, directory), { mode: 0o700 });
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
    privateParents(home, dirname(target));
    const existing = liveFile(target);
    let data = source;
    if (file.merge && existing) {
      const live = read(target);
      if (live !== null) data = mergeKeys(live, source, file.merge);
    }
    replaceFile(target, data, existing ? (existing.mode & 0o600) | 0o400 : 0o600);
    published += 1;
  }
  if (published === 0) throw new Error("Provider did not write credentials");
}

function read(path: string): Buffer | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new Error("Provider credentials path is a symlink", { cause: error });
    throw error;
  }
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("Provider credentials path is not a file");
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function liveFile(path: string) {
  try {
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error("Provider credentials path is not a file");
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function privateParents(home: string, directory: string): void {
  const path = relative(home, directory);
  if (path.startsWith("..") || path.startsWith(sep))
    throw new Error("Provider credentials path leaves its home");
  let current = home;
  for (const part of ["", ...path.split(sep).filter(Boolean)]) {
    current = part ? join(current, part) : current;
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o770 });
      info = lstatSync(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Provider credentials folder is not a private directory");
    if (process.getuid && info.uid !== process.getuid())
      throw new Error("Provider credentials folder belongs to another user");
    if (part && (info.mode & 0o007) !== 0) chmodSync(current, info.mode & 0o770);
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

function replaceFile(target: string, data: Buffer, mode: number): void {
  const directory = dirname(target);
  const temporary = join(directory, `.${randomUUID()}.paws-login`);
  try {
    const descriptor = openSync(temporary, "wx", mode);
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
