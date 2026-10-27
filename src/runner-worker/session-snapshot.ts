import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  writeSync,
  type Stats,
} from "node:fs";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { createGzip } from "node:zlib";

/** The bundle and its description in a run's output directory, for the runner runtime. */
export const SESSION_BUNDLE_FILE = "session.ndjson.gz";
export const SESSION_METADATA_FILE = "session.json";
export const CLAUDE_SESSION_TOO_LARGE = "The Claude session is too large to save for a move.";
export const CODEX_SESSION_TOO_LARGE = "The Codex session is too large to save for a move.";
export const GROK_SESSION_TOO_LARGE = "The Grok session is too large to save for a move.";

/** Claude keys a session directory by its cwd and shortens names over 200 characters. */
const CLAUDE_PROJECT_NAME_LIMIT = 200;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** A Codex thread id is a UUID; anything else never names a rollout file. */
const CODEX_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** `rollout-2026-10-27T00-38-23-<thread id>.jsonl`, as Codex names a session's rollout. */
const CODEX_ROLLOUT =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.jsonl$/;
/** A Grok session id is a UUIDv7 unless the client names one. */
const GROK_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Grok gives a longer encoded cwd a slug and hash; that folder is not keyed by the path alone. */
const GROK_CWD_NAME_LIMIT = 255;
/** Grok's credential and settings files; never part of a bundle, at any depth. */
export const GROK_EXCLUDED_FILES: ReadonlySet<string> = new Set([
  "auth.json",
  "config.toml",
  "mcp_credentials.json",
  "managed_config.toml",
  "requirements.toml",
  "permission.toml",
]);
/** A file or folder name the restore accepts. */
const BUNDLE_NAME = /^[A-Za-z0-9._-]{1,255}$/;
/** A multiple of 3, so each piece but the last encodes to base64 without padding. */
const READ_BYTES = 196_608;

export class SessionTooLargeError extends Error {}

/** The thread id a Codex rollout file name holds, or undefined for any other name. */
export function codexRolloutSession(name: string): string | undefined {
  return CODEX_ROLLOUT.exec(name)?.[1];
}

/**
 * The folder Grok groups a cwd's sessions under: the cwd URL-encoded with uppercase hex, so
 * `/var/lib/paws-agent/work/01J…` is `%2Fvar%2Flib%2Fpaws-agent%2Fwork%2F01J…`. Undefined when
 * the name passes 255 bytes and Grok would use a slug and hash instead.
 */
export function grokCwdFolder(cwd: string): string | undefined {
  let name = "";
  for (const byte of Buffer.from(cwd, "utf8"))
    name += /[A-Za-z0-9._~-]/.test(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  return name.length <= GROK_CWD_NAME_LIMIT && name !== "." && name !== ".." ? name : undefined;
}

export type SessionBundle = {
  /** Relative to the agent home, as written in the bundle. */
  files: string[];
  /** Files next to the session that the allowlist refused. */
  refused: number;
  sizeBytes: number;
  sha256: string;
};

function child(directory: number, name: string, flags: number): number {
  return openSync(
    `/proc/self/fd/${directory}/${name}`,
    flags | constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A regular file with one link, or null for anything the allowlist refuses. */
function regular(directory: number, name: string): { fd: number; info: Stats } | null {
  let fd: number;
  try {
    fd = child(directory, name, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw error;
  }
  const info = fstatSync(fd);
  if (info.isFile() && info.nlink === 1) return { fd, info };
  closeSync(fd);
  return null;
}

type SessionFile = { fd: number; info: Stats };

/**
 * A gzipped NDJSON bundle written to `output` as entries are added. Each line is
 * `{path, mode, data}` with `data` in base64; files are read in pieces, never whole.
 */
function bundleWriter(output: number, maxBytes: number) {
  const gzip = createGzip();
  const digest = createHash("sha256");
  let size = 0;
  let tooLarge = false;
  // Gzip emits data outside any await, so a write failure ends the stream with that error
  // and the next push, drain or finish rejects with it instead of escaping the worker.
  let failure: Error | undefined;
  gzip.on("error", (error: Error) => {
    failure ??= error;
  });
  gzip.on("data", (chunk: Buffer) => {
    if (tooLarge || failure) return;
    size += chunk.length;
    if (size > maxBytes) {
      tooLarge = true;
      return;
    }
    digest.update(chunk);
    try {
      for (let written = 0; written < chunk.length;) written += writeSync(output, chunk, written);
    } catch (error) {
      gzip.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const push = async (data: string | Buffer) => {
    if (failure) throw failure;
    if (tooLarge) throw new SessionTooLargeError();
    if (!gzip.write(data)) await once(gzip, "drain");
  };
  const files: string[] = [];
  const buffer = Buffer.alloc(READ_BYTES);
  return {
    files,
    async add(file: SessionFile, path: string) {
      files.push(path);
      await push(`{"path":${JSON.stringify(path)},"mode":${file.info.mode & 0o777},"data":"`);
      while (true) {
        let filled = 0;
        while (filled < buffer.length) {
          const count = readSync(file.fd, buffer, filled, buffer.length - filled, null);
          if (count === 0) break;
          filled += count;
        }
        if (filled) await push(buffer.subarray(0, filled).toString("base64"));
        if (filled < buffer.length) break;
      }
      await push('"}\n');
    },
    async finish(): Promise<{ sizeBytes: number; sha256: string }> {
      if (failure) throw failure;
      gzip.end();
      await finished(gzip);
      if (failure) throw failure;
      if (tooLarge) throw new SessionTooLargeError();
      return { sizeBytes: size, sha256: digest.digest("hex") };
    },
    destroy() {
      gzip.destroy();
    },
  };
}

/**
 * Writes Claude's native files for `sessionId` as gzipped NDJSON to `output`: the session's
 * `<sessionId>.jsonl` under `projects/<sanitized cwd>/` and its `<sessionId>/` sidecar folder.
 * Each line is `{path, mode, data}` with `path` relative to `home` and `data` in base64.
 * Nothing else under `.claude` is read. Links, files with more than one link, other file types
 * and credential files are refused. Returns null when the session has no file.
 * Throws `SessionTooLargeError` once the gzipped bundle passes `maxBytes`.
 */
export async function writeClaudeSessionBundle(options: {
  home: string;
  cwd: string;
  sessionId: string;
  output: number;
  maxBytes: number;
}): Promise<SessionBundle | null> {
  if (!SESSION_ID.test(options.sessionId)) throw new Error("Invalid Claude session id");
  const sanitized = options.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const opened: number[] = [];
  const directory = (parent: number, name: string) => {
    const fd = child(parent, name, constants.O_DIRECTORY);
    opened.push(fd);
    return fd;
  };
  const writer = bundleWriter(options.output, options.maxBytes);
  try {
    const home = openSync(options.home, constants.O_RDONLY | constants.O_DIRECTORY);
    opened.push(home);
    let projects: number;
    try {
      projects = directory(directory(home, ".claude"), "projects");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    // Claude shortens a long name and adds a hash; only a folder with the session file matches.
    const names =
      sanitized.length <= CLAUDE_PROJECT_NAME_LIMIT
        ? [sanitized]
        : readdirSync(`/proc/self/fd/${projects}`).filter((name) =>
            name.startsWith(`${sanitized.slice(0, CLAUDE_PROJECT_NAME_LIMIT)}-`),
          );
    let project: { name: string; fd: number } | undefined;
    let session: SessionFile | null = null;
    for (const name of names) {
      let fd: number;
      try {
        fd = directory(projects, name);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      try {
        session = regular(fd, `${options.sessionId}.jsonl`);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      if (!session) throw new Error("The Claude session file is not a regular file");
      project = { name, fd };
      break;
    }
    if (!project || !session) return null;

    let refused = 0;
    const base = `.claude/projects/${project.name}`;
    try {
      await writer.add(session, `${base}/${options.sessionId}.jsonl`);
    } finally {
      closeSync(session.fd);
    }
    const walk = async (parent: number, path: string) => {
      const entries = readdirSync(`/proc/self/fd/${parent}`, { withFileTypes: true }).sort(
        (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await walk(directory(parent, entry.name), `${path}/${entry.name}`);
          continue;
        }
        const file =
          entry.isFile() && entry.name !== ".credentials.json" ? regular(parent, entry.name) : null;
        if (!file) {
          refused++;
          continue;
        }
        try {
          await writer.add(file, `${path}/${entry.name}`);
        } finally {
          closeSync(file.fd);
        }
      }
    };
    let sidecar: number | undefined;
    try {
      sidecar = directory(project.fd, options.sessionId);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "ENOTDIR") refused++;
      else if (code !== "ENOENT") throw error;
    }
    if (sidecar !== undefined) await walk(sidecar, `${base}/${options.sessionId}`);
    return { files: writer.files, refused, ...(await writer.finish()) };
  } finally {
    writer.destroy();
    for (const fd of opened) closeSync(fd);
  }
}

/**
 * Writes Codex's rollout for `sessionId` (its thread id) as a one-entry bundle to `output`, at
 * `.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl`. Codex finds a rollout by
 * thread id in any date folder, so the newest match wins. Nothing else under `.codex` is read:
 * not `auth.json`, `config.toml`, Codex's databases or other rollouts. A rollout that is a link
 * or has more than one link is refused. Returns null when the session has no rollout.
 * Throws `SessionTooLargeError` once the gzipped bundle passes `maxBytes`.
 */
export async function writeCodexSessionBundle(options: {
  home: string;
  sessionId: string;
  output: number;
  maxBytes: number;
}): Promise<SessionBundle | null> {
  if (!CODEX_SESSION_ID.test(options.sessionId)) throw new Error("Invalid Codex session id");
  const opened: number[] = [];
  const directory = (parent: number, name: string) => {
    const fd = child(parent, name, constants.O_DIRECTORY);
    opened.push(fd);
    return fd;
  };
  const folders = (parent: number, pattern: RegExp) =>
    readdirSync(`/proc/self/fd/${parent}`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  const writer = bundleWriter(options.output, options.maxBytes);
  try {
    const home = openSync(options.home, constants.O_RDONLY | constants.O_DIRECTORY);
    opened.push(home);
    let sessions: number;
    try {
      sessions = directory(directory(home, ".codex"), "sessions");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    for (const year of folders(sessions, /^\d{4}$/)) {
      const yearFd = directory(sessions, year);
      for (const month of folders(yearFd, /^\d{2}$/)) {
        const monthFd = directory(yearFd, month);
        for (const day of folders(monthFd, /^\d{2}$/)) {
          const dayFd = directory(monthFd, day);
          const name = readdirSync(`/proc/self/fd/${dayFd}`).find(
            (entry) => codexRolloutSession(entry) === options.sessionId,
          );
          if (!name) continue;
          const rollout = regular(dayFd, name);
          if (!rollout) throw new Error("The Codex rollout is not a regular file");
          try {
            await writer.add(rollout, `.codex/sessions/${year}/${month}/${day}/${name}`);
          } finally {
            closeSync(rollout.fd);
          }
          return { files: writer.files, refused: 0, ...(await writer.finish()) };
        }
      }
    }
    return null;
  } finally {
    writer.destroy();
    for (const fd of opened) closeSync(fd);
  }
}

/**
 * Writes Grok's session folder for `sessionId` as a bundle to `output`: every file under
 * `.grok/sessions/<encoded cwd>/<sessionId>/`, subfolders included. Nothing else under `.grok`
 * is read: not `auth.json`, `config.toml`, `mcp_credentials.json`, the cwd folder's
 * `permission.toml`, the search index or other sessions. Links, files with more than one link,
 * other file types and credential names are refused. Returns null when the session has no
 * `updates.jsonl`, the log Grok's `session/load` reads.
 * Throws `SessionTooLargeError` once the gzipped bundle passes `maxBytes`.
 */
export async function writeGrokSessionBundle(options: {
  home: string;
  cwd: string;
  sessionId: string;
  output: number;
  maxBytes: number;
}): Promise<SessionBundle | null> {
  if (!GROK_SESSION_ID.test(options.sessionId)) throw new Error("Invalid Grok session id");
  const folder = grokCwdFolder(options.cwd);
  if (!folder) return null;
  const opened: number[] = [];
  const directory = (parent: number, name: string) => {
    const fd = child(parent, name, constants.O_DIRECTORY);
    opened.push(fd);
    return fd;
  };
  const writer = bundleWriter(options.output, options.maxBytes);
  try {
    const home = openSync(options.home, constants.O_RDONLY | constants.O_DIRECTORY);
    opened.push(home);
    let session: number;
    try {
      session = directory(
        directory(directory(directory(home, ".grok"), "sessions"), folder),
        options.sessionId,
      );
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    let log: SessionFile | null;
    try {
      log = regular(session, "updates.jsonl");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (!log) throw new Error("The Grok session log is not a regular file");
    closeSync(log.fd);

    let refused = 0;
    const walk = async (parent: number, path: string) => {
      const entries = readdirSync(`/proc/self/fd/${parent}`, { withFileTypes: true }).sort(
        (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
      for (const entry of entries) {
        // A name the restore would refuse is left out rather than spoiling the whole bundle.
        if (!BUNDLE_NAME.test(entry.name)) {
          refused++;
          continue;
        }
        if (entry.isDirectory()) {
          await walk(directory(parent, entry.name), `${path}/${entry.name}`);
          continue;
        }
        const file =
          entry.isFile() && !GROK_EXCLUDED_FILES.has(entry.name)
            ? regular(parent, entry.name)
            : null;
        if (!file) {
          refused++;
          continue;
        }
        try {
          await writer.add(file, `${path}/${entry.name}`);
        } finally {
          closeSync(file.fd);
        }
      }
    };
    await walk(session, `.grok/sessions/${folder}/${options.sessionId}`);
    return { files: writer.files, refused, ...(await writer.finish()) };
  } finally {
    writer.destroy();
    for (const fd of opened) closeSync(fd);
  }
}
