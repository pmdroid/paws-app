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

/** Claude keys a session directory by its cwd and shortens names over 200 characters. */
const CLAUDE_PROJECT_NAME_LIMIT = 200;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** A multiple of 3, so each piece but the last encodes to base64 without padding. */
const READ_BYTES = 196_608;

export class SessionTooLargeError extends Error {}

export type ClaudeSessionBundle = {
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
}): Promise<ClaudeSessionBundle | null> {
  if (!SESSION_ID.test(options.sessionId)) throw new Error("Invalid Claude session id");
  const sanitized = options.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const opened: number[] = [];
  const directory = (parent: number, name: string) => {
    const fd = child(parent, name, constants.O_DIRECTORY);
    opened.push(fd);
    return fd;
  };
  const gzip = createGzip();
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
    let session: { fd: number; info: Stats } | null = null;
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

    const digest = createHash("sha256");
    let size = 0;
    let tooLarge = false;
    gzip.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > options.maxBytes) {
        tooLarge = true;
        return;
      }
      digest.update(chunk);
      for (let written = 0; written < chunk.length;)
        written += writeSync(options.output, chunk, written);
    });
    const push = async (data: string | Buffer) => {
      if (tooLarge) throw new SessionTooLargeError();
      if (!gzip.write(data)) await once(gzip, "drain");
    };
    const files: string[] = [];
    let refused = 0;
    const buffer = Buffer.alloc(READ_BYTES);
    const add = async (file: { fd: number; info: Stats }, path: string) => {
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
    };
    const base = `.claude/projects/${project.name}`;
    try {
      await add(session, `${base}/${options.sessionId}.jsonl`);
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
          await add(file, `${path}/${entry.name}`);
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
    gzip.end();
    await finished(gzip);
    if (tooLarge) throw new SessionTooLargeError();
    return { files, refused, sizeBytes: size, sha256: digest.digest("hex") };
  } finally {
    gzip.destroy();
    for (const fd of opened) closeSync(fd);
  }
}
