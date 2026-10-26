import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { AGENT_SESSION_OBJECT_MAX_BYTES } from "./schema";

/** Encrypted snapshot chunks. Callers only ever hand it ciphertext. */
export interface AgentSessionObjects {
  write(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array>;
}

/** Chunks under `~/.paws/agent-sessions`: an owner-only 0700 directory of 0600 files, no links. */
export function createLocalAgentSessionObjects(root: string): AgentSessionObjects {
  if (!isAbsolute(root)) throw new Error("Agent session directory must be absolute");
  function directory() {
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (info.uid !== process.getuid!() || (info.mode & 0o7777) !== 0o700) {
      closeSync(fd);
      throw new Error("Unsafe agent session directory");
    }
    return fd;
  }
  function name(key: string) {
    if (!key || key.length > 2048) throw new Error("Invalid agent session key");
    return createHash("sha256").update(key).digest("hex") + ".bin";
  }
  return {
    async write(key, bytes) {
      const filename = name(key);
      if (bytes.byteLength > AGENT_SESSION_OBJECT_MAX_BYTES)
        throw new Error("Agent session chunk exceeds size limit");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const rootFd = directory();
      const temporary = `/proc/self/fd/${rootFd}/${randomUUID()}.tmp`;
      let fd: number | undefined;
      try {
        fd = openSync(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
          if (written <= 0) throw new Error("Agent session write did not advance");
          offset += written;
        }
        fsyncSync(fd);
        renameSync(temporary, `/proc/self/fd/${rootFd}/${filename}`);
        fsyncSync(rootFd);
      } finally {
        try {
          if (fd !== undefined) closeSync(fd);
          rmSync(temporary, { force: true });
        } finally {
          closeSync(rootFd);
        }
      }
    },
    async read(key) {
      const filename = name(key);
      const rootFd = directory();
      let fd: number | undefined;
      try {
        fd = openSync(
          `/proc/self/fd/${rootFd}/${filename}`,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const info = fstatSync(fd);
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.uid !== process.getuid!() ||
          (info.mode & 0o7777) !== 0o600 ||
          info.size > AGENT_SESSION_OBJECT_MAX_BYTES
        )
          throw new Error("Unsafe agent session file");
        const bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (read <= 0) throw new Error("Agent session file changed while reading");
          offset += read;
        }
        if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0)
          throw new Error("Agent session file changed while reading");
        return bytes;
      } finally {
        if (fd !== undefined) closeSync(fd);
        closeSync(rootFd);
      }
    },
  };
}

export function createFakeAgentSessionObjects() {
  const objects = new Map<string, Uint8Array>();
  const writes: string[] = [];
  return {
    objects,
    writes,
    async write(key: string, bytes: Uint8Array) {
      objects.set(key, new Uint8Array(bytes));
      writes.push(key);
    },
    async read(key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("Agent session object missing");
      return new Uint8Array(bytes);
    },
  } satisfies AgentSessionObjects & { objects: Map<string, Uint8Array>; writes: string[] };
}
