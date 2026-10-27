import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { codexRolloutSession, GROK_EXCLUDED_FILES, grokCwdFolder } from "./session-snapshot";

/** The bundle's checksum or size is not the one the signed command names. */
export class SessionIntegrityError extends Error {}
/** The bundle holds an entry the allowlist refuses, or is not a bundle at all. */
export class SessionUnpackError extends Error {}

/** Claude keys a session directory by its cwd and shortens names over 200 characters. */
const CLAUDE_PROJECT_NAME_LIMIT = 200;
/** The most a restored session may unpack to, against a bundle that inflates without end. */
const MAX_UNPACKED_BYTES = 17_179_869_184;
const HEADER_LIMIT = 8_192;
const DATA_MARKER = ',"data":"';
const SEGMENT = /^[A-Za-z0-9._-]{1,255}$/;

export type RestoredAgentSession = {
  /** Files written, relative to the agent home. */
  files: string[];
  /** Directories created, deepest last. */
  directories: string[];
};

function refuse(message: string): never {
  throw new SessionUnpackError(message);
}

/** The bundle path's parts, and whether it is the session file the bundle must hold. */
type AllowedPath = (path: string) => { parts: string[]; session: boolean };

function pathParts(path: string): string[] {
  const parts = path.split("/");
  if (
    path.startsWith("/") ||
    parts.some((part) => part === "" || part === "." || part === ".." || !SEGMENT.test(part))
  )
    refuse("The session bundle holds a path outside the session folder");
  return parts;
}

/**
 * The bundle path's parts when it is the session's `.jsonl` or a file in its sidecar folder,
 * under the project folder for `cwd`. Anything else, `..`, absolute paths and credential
 * files are refused.
 */
function claudePath(path: string, cwd: string, sessionId: string): string[] {
  const parts = pathParts(path);
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const project = parts[2] ?? "";
  if (
    parts[0] !== ".claude" ||
    parts[1] !== "projects" ||
    !(sanitized.length <= CLAUDE_PROJECT_NAME_LIMIT
      ? project === sanitized
      : project.startsWith(`${sanitized.slice(0, CLAUDE_PROJECT_NAME_LIMIT)}-`)) ||
    !(
      (parts.length === 4 && parts[3] === `${sessionId}.jsonl`) ||
      (parts.length > 4 && parts[3] === sessionId)
    ) ||
    parts.at(-1) === ".credentials.json"
  )
    refuse("The session bundle holds a path outside the session folder");
  return parts;
}

/**
 * The bundle path's parts when it is the rollout for `sessionId` in a date folder under
 * `.codex/sessions`. Anything else, including `auth.json`, `config.toml` and other rollouts,
 * is refused.
 */
function codexPath(path: string, sessionId: string): string[] {
  const parts = pathParts(path);
  if (
    parts.length !== 6 ||
    parts[0] !== ".codex" ||
    parts[1] !== "sessions" ||
    !/^\d{4}$/.test(parts[2]!) ||
    !/^\d{2}$/.test(parts[3]!) ||
    !/^\d{2}$/.test(parts[4]!) ||
    codexRolloutSession(parts[5]!) !== sessionId
  )
    refuse("The session bundle holds a path outside the session folder");
  return parts;
}

/**
 * The bundle path's parts when it is a file in the folder for `sessionId` under
 * `.grok/sessions/<encoded cwd>`. Anything else, including `auth.json`, `config.toml`,
 * `mcp_credentials.json`, the cwd folder's own files and other sessions, is refused.
 */
function grokPath(path: string, cwd: string, sessionId: string): string[] {
  const folder = grokCwdFolder(cwd);
  const parts = path.split("/");
  // The encoded cwd holds `%`, which no other segment may; it must be this cwd's exactly.
  pathParts([...parts.slice(0, 2), ...parts.slice(3)].join("/"));
  if (
    !folder ||
    parts.length < 5 ||
    parts[0] !== ".grok" ||
    parts[1] !== "sessions" ||
    parts[2] !== folder ||
    parts[3] !== sessionId ||
    GROK_EXCLUDED_FILES.has(parts.at(-1)!)
  )
    refuse("The session bundle holds a path outside the session folder");
  return parts;
}

/**
 * The bundle's bytes, read in step with the consumer. Each read is synchronous, so none is in flight
 * when an early exit destroys the stream and closes the descriptor.
 */
function* bundleChunks(fd: number): Generator<Buffer> {
  let position = 0;
  while (true) {
    const buffer = Buffer.alloc(1_048_576);
    const count = readSync(fd, buffer, 0, buffer.length, position);
    if (count === 0) return;
    position += count;
    yield buffer.subarray(0, count);
  }
}

/** Hashes the whole bundle file and checks it against the signed size and sha256. */
function verifyBundle(fd: number, sizeBytes: number, sha256: string): void {
  const info = fstatSync(fd);
  if (!info.isFile() || info.size !== sizeBytes)
    throw new SessionIntegrityError("The session bundle has the wrong size");
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(1_048_576);
  let total = 0;
  while (true) {
    const count = readSync(fd, buffer, 0, buffer.length, total);
    if (count === 0) break;
    digest.update(buffer.subarray(0, count));
    total += count;
  }
  if (total !== sizeBytes || digest.digest("hex") !== sha256)
    throw new SessionIntegrityError("The session bundle does not match its checksum");
}

type BundleSource = { bundle: string; home: string; sizeBytes: number; sha256: string };

/** Unpacks a Claude session bundle from `writeClaudeSessionBundle`, as `restoreSessionBundle`. */
export function restoreClaudeSessionBundle(
  options: BundleSource & { cwd: string; sessionId: string },
): Promise<RestoredAgentSession> {
  return restoreSessionBundle(options, (path) => {
    const parts = claudePath(path, options.cwd, options.sessionId);
    return { parts, session: parts.length === 4 };
  });
}

/**
 * Unpacks a Codex bundle from `writeCodexSessionBundle`, as `restoreSessionBundle`: the one
 * rollout, in the date folder it was saved from. A second entry is refused.
 */
export function restoreCodexSessionBundle(
  options: BundleSource & { sessionId: string },
): Promise<RestoredAgentSession> {
  let seen = false;
  return restoreSessionBundle(options, (path) => {
    if (seen) refuse("The session bundle holds more than the Codex rollout");
    seen = true;
    return { parts: codexPath(path, options.sessionId), session: true };
  });
}

/**
 * Unpacks a Grok bundle from `writeGrokSessionBundle`, as `restoreSessionBundle`: the session
 * folder, under the same encoded cwd it was saved from. The bundle must hold `updates.jsonl`.
 */
export function restoreGrokSessionBundle(
  options: BundleSource & { cwd: string; sessionId: string },
): Promise<RestoredAgentSession> {
  return restoreSessionBundle(options, (path) => {
    const parts = grokPath(path, options.cwd, options.sessionId);
    return { parts, session: parts.length === 5 && parts[4] === "updates.jsonl" };
  });
}

/**
 * Unpacks a session bundle into `home`, at the same paths it was saved from. The whole file is
 * checked against `sha256` first, then each entry is streamed without holding the file in memory.
 * Each path must pass `allowed`. Directories are opened without following links, an existing
 * link or non-file at a target path is refused, and files are written with mode 0600 through a
 * staging name. On any failure everything written is removed before the error is thrown.
 */
async function restoreSessionBundle(
  options: BundleSource,
  allowed: AllowedPath,
): Promise<RestoredAgentSession> {
  const restored: RestoredAgentSession = { files: [], directories: [] };
  const source = openSync(options.bundle, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: Readable | undefined;
  try {
    verifyBundle(source, options.sizeBytes, options.sha256);
    const home = options.home.replace(/\/+$/, "");
    let unpacked = 0;
    let header = "";
    let entry: { fd: number; staging: string; target: string; path: string } | undefined;
    let pending = "";
    // "header": reading `{"path":…,"mode":…,"data":"`; "data": base64 up to `"`; "tail": `}\n`.
    let state: "header" | "data" | "tail" = "header";
    let tail = "";
    let sawSession = false;

    const directory = (parts: string[]) => {
      let path = home;
      for (const part of parts) {
        path = `${path}/${part}`;
        let info;
        try {
          info = lstatSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          mkdirSync(path, { mode: 0o700 });
          restored.directories.push(path);
          continue;
        }
        if (!info.isDirectory() || info.isSymbolicLink())
          refuse("The session folder on this runner holds a link");
      }
      return path;
    };
    const open = (rawHeader: string) => {
      let parsed: { path?: unknown; mode?: unknown };
      try {
        parsed = JSON.parse(`${rawHeader}"}`) as typeof parsed;
      } catch {
        refuse("The session bundle entry is malformed");
      }
      if (typeof parsed.path !== "string" || typeof parsed.mode !== "number")
        refuse("The session bundle entry is malformed");
      const { parts, session } = allowed(parsed.path);
      if (session) sawSession = true;
      const parent = directory(parts.slice(0, -1));
      const target = `${parent}/${parts.at(-1)}`;
      try {
        const info = lstatSync(target);
        if (!info.isFile() || info.isSymbolicLink())
          refuse("The session file on this runner is a link or not a file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const staging = `${parent}/.${parts.at(-1)}.${randomUUID()}.restore`;
      const fd = openSync(
        staging,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(fd, 0o600);
      entry = { fd, staging, target, path: parsed.path };
    };
    const write = (base64: string) => {
      if (!entry) return;
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) refuse("The session bundle data is malformed");
      const bytes = Buffer.from(base64, "base64");
      unpacked += bytes.length;
      if (unpacked > MAX_UNPACKED_BYTES) refuse("The session bundle unpacks too large");
      for (let written = 0; written < bytes.length;) written += writeSync(entry.fd, bytes, written);
    };
    const close = () => {
      if (!entry) return;
      const { fd, staging, target, path } = entry;
      entry = undefined;
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(staging, target);
      restored.files.push(path);
    };

    try {
      input = Readable.from(bundleChunks(source));
      const gunzip = input.pipe(createGunzip());
      for await (const chunk of gunzip as AsyncIterable<Buffer>) {
        let text = chunk.toString("latin1");
        while (text.length) {
          if (state === "header") {
            header += text;
            text = "";
            const at = header.indexOf(DATA_MARKER);
            if (at < 0) {
              if (header.length > HEADER_LIMIT) refuse("The session bundle entry is malformed");
              continue;
            }
            const rawHeader = header.slice(0, at + DATA_MARKER.length);
            text = header.slice(at + DATA_MARKER.length);
            header = "";
            if (!rawHeader.startsWith('{"path":')) refuse("The session bundle entry is malformed");
            open(Buffer.from(rawHeader, "latin1").toString("utf8"));
            state = "data";
          } else if (state === "data") {
            const end = text.indexOf('"');
            const piece = pending + (end < 0 ? text : text.slice(0, end));
            text = end < 0 ? "" : text.slice(end + 1);
            if (end < 0) {
              const whole = piece.length - (piece.length % 4);
              write(piece.slice(0, whole));
              pending = piece.slice(whole);
            } else {
              write(piece);
              pending = "";
              close();
              state = "tail";
            }
          } else {
            const need = 2 - tail.length;
            tail += text.slice(0, need);
            text = text.slice(need);
            if (tail.length === 2) {
              if (tail !== "}\n") refuse("The session bundle entry is malformed");
              tail = "";
              state = "header";
            }
          }
        }
      }
      if (state !== "header" || header.length || !sawSession)
        refuse("The session bundle is incomplete");
      return restored;
    } catch (error) {
      if (entry) {
        closeSync(entry.fd);
        rmSync(entry.staging, { force: true });
        entry = undefined;
      }
      removeRestoredSession(home, restored);
      if (error instanceof SessionIntegrityError || error instanceof SessionUnpackError)
        throw error;
      throw new SessionUnpackError(
        `The session bundle could not be unpacked: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    input?.destroy();
    closeSync(source);
  }
}

/** Removes restored files and the folders the restore created, never following a link. */
export function removeRestoredSession(home: string, restored: RestoredAgentSession): void {
  const base = home.replace(/\/+$/, "");
  for (const path of restored.files) {
    try {
      const target = `${base}/${path}`;
      if (!lstatSync(target).isDirectory()) unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // A folder the restore created goes only when empty: a new session may already be beside it.
  for (const directory of [...restored.directories].reverse())
    try {
      if (lstatSync(directory).isDirectory()) rmdirSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    }
  restored.files.length = 0;
  restored.directories.length = 0;
}
