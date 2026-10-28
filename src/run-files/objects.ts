import type { S3Client } from "bun";
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
import { RUN_FILE_KINDS, RUN_FILE_OBJECT_MAX_BYTES, type RunFileKind } from "./kinds";

/** Encrypted run file chunks, one object per chunk. Callers only ever hand it ciphertext. */
export interface RunFileObjects {
  write(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array>;
  /** Removes a chunk; a missing one is not an error. */
  delete(key: string): Promise<void>;
}

function label(kind: RunFileKind) {
  const { noun } = RUN_FILE_KINDS[kind];
  return { noun, Noun: noun[0]!.toUpperCase() + noun.slice(1) };
}

/** Chunks under `~/.paws/<kind directory>`: an owner-only 0700 directory of 0600 files, no links. */
export function createLocalRunFileObjects(kind: RunFileKind, root: string): RunFileObjects {
  const { noun, Noun } = label(kind);
  if (!isAbsolute(root)) throw new Error(`${Noun} directory must be absolute`);
  function directory() {
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (info.uid !== process.getuid!() || (info.mode & 0o7777) !== 0o700) {
      closeSync(fd);
      throw new Error(`Unsafe ${noun} directory`);
    }
    return fd;
  }
  function name(key: string) {
    if (!key || key.length > 2048) throw new Error(`Invalid ${noun} key`);
    return createHash("sha256").update(key).digest("hex") + RUN_FILE_KINDS[kind].suffix;
  }
  return {
    async write(key, bytes) {
      const filename = name(key);
      if (bytes.byteLength > RUN_FILE_OBJECT_MAX_BYTES)
        throw new Error(`${Noun} chunk exceeds size limit`);
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
          if (written <= 0) throw new Error(`${Noun} write did not advance`);
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
          info.size > RUN_FILE_OBJECT_MAX_BYTES
        )
          throw new Error(`Unsafe ${noun} file`);
        const bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (read <= 0) throw new Error(`${Noun} file changed while reading`);
          offset += read;
        }
        if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0)
          throw new Error(`${Noun} file changed while reading`);
        return bytes;
      } finally {
        if (fd !== undefined) closeSync(fd);
        closeSync(rootFd);
      }
    },
    async delete(key) {
      const filename = name(key);
      let rootFd: number;
      try {
        rootFd = directory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      try {
        rmSync(`/proc/self/fd/${rootFd}/${filename}`, { force: true });
        fsyncSync(rootFd);
      } finally {
        closeSync(rootFd);
      }
    },
  };
}

/** Chunks in the configured transcript S3 bucket. Each object is one sealed chunk. */
export function createS3RunFileObjects(
  kind: RunFileKind,
  options: { client: S3Client; bucket: string },
): RunFileObjects {
  const { noun, Noun } = label(kind);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket))
    throw new Error(`Invalid ${noun} bucket`);
  return {
    async write(key, bytes) {
      if (bytes.byteLength > RUN_FILE_OBJECT_MAX_BYTES)
        throw new Error(`${Noun} chunk exceeds size limit`);
      await options.client.file(key).write(bytes, { type: "application/octet-stream", retry: 1 });
    },
    async read(key) {
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const part of options.client.file(key).stream()) {
        size += part.byteLength;
        if (size > RUN_FILE_OBJECT_MAX_BYTES) throw new Error(`${Noun} object exceeds size limit`);
        parts.push(part);
      }
      return Buffer.concat(parts);
    },
    async delete(key) {
      await options.client.file(key).delete();
    },
  };
}

/**
 * Writes go to `remote`. Reads use the local chunk when one exists, so files sealed before S3
 * was configured still read. Deletes remove the chunk from both.
 */
export function withLocalRunFileFallback(
  local: RunFileObjects,
  remote: RunFileObjects,
): RunFileObjects {
  return {
    write: (key, bytes) => remote.write(key, bytes),
    async read(key) {
      try {
        return await local.read(key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return remote.read(key);
      }
    },
    async delete(key) {
      await local.delete(key);
      await remote.delete(key);
    },
  };
}

export function createFakeRunFileObjects() {
  const objects = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const deletes: string[] = [];
  return {
    objects,
    writes,
    deletes,
    async write(key: string, bytes: Uint8Array) {
      objects.set(key, new Uint8Array(bytes));
      writes.push(key);
    },
    async read(key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("Run file object missing");
      return new Uint8Array(bytes);
    },
    async delete(key: string) {
      objects.delete(key);
      deletes.push(key);
    },
  } satisfies RunFileObjects & {
    objects: Map<string, Uint8Array>;
    writes: string[];
    deletes: string[];
  };
}
