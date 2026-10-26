import { journalCaught } from "../journal";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { pathToFileURL } from "node:url";
import type { RunnerTranscriptObjects } from "./objects";
import { RUNNER_TRANSCRIPT_MAX_BYTES } from "./schema";

export function createLocalRunnerTranscriptObjects(root: string): RunnerTranscriptObjects {
  if (!isAbsolute(root)) throw new Error("Transcript directory must be absolute");
  function directory() {
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (info.uid !== process.getuid!() || (info.mode & 0o7777) !== 0o700) {
      closeSync(fd);
      throw new Error("Unsafe transcript directory");
    }
    return fd;
  }
  function name(key: string) {
    if (!key || key.length > 2048) throw new Error("Invalid transcript key");
    return createHash("sha256").update(key).digest("hex") + ".jsonl";
  }
  return {
    async write(key, bytes) {
      const filename = name(key);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const rootFd = directory();
      const temporary = `/proc/self/fd/${rootFd}/${randomUUID()}.tmp`;
      let fd: number | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        reader = (bytes instanceof Blob ? bytes.stream() : bytes).getReader();
        fd = openSync(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        let size = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > RUNNER_TRANSCRIPT_MAX_BYTES) throw new Error("Transcript exceeds size limit");
          let offset = 0;
          while (offset < part.value.byteLength) {
            const written = writeSync(fd, part.value, offset, part.value.byteLength - offset);
            if (written <= 0) throw new Error("Transcript write did not advance");
            offset += written;
          }
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
          await reader?.cancel().catch((caughtError1) => {
            journalCaught(caughtError1, "local-objects.write.cancel", null);
            return undefined;
          });
          reader?.releaseLock();
        }
      }
    },
    read(key) {
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
          info.size > RUNNER_TRANSCRIPT_MAX_BYTES
        )
          throw new Error("Unsafe transcript file");
        const stream = Readable.toWeb(createReadStream("", { fd, autoClose: true }));
        fd = undefined;
        return stream as ReadableStream<Uint8Array>;
      } finally {
        if (fd !== undefined) closeSync(fd);
        closeSync(rootFd);
      }
    },
    uri: (key) => pathToFileURL(join(root, name(key))).href,
  };
}
