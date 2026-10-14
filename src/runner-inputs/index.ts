import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { SQLiteError } from "bun:sqlite";
import { z } from "zod";
import {
  RUNNER_INPUT_CHUNK_BYTES,
  RUNNER_PROMPT_CONTEXT_MAX_BYTES,
  RunnerPromptContextSchema,
  type RunnerPromptContext,
  RUNNER_INPUT_MAX_BYTES,
  RunnerInputFilesSchema,
  type RunnerInputFile,
} from "../runner-protocol";
import { RunnerWorkFencedError, type RunnerWork } from "../runner-work";

export class RunnerInputStorageError extends Error {}
export type RunnerInputSource = { path: string; mimeType: string; bytes: Uint8Array };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const contextRequestSchema = z.strictObject({
  commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  offset: z.number().int().min(0).max(RUNNER_PROMPT_CONTEXT_MAX_BYTES),
});
const requestSchema = contextRequestSchema.extend({
  fileId: z.number().int().min(0).max(20),
  offset: z.number().int().min(0).max(RUNNER_INPUT_MAX_BYTES),
});
function privateFile(path: string, limit: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o7777) !== 0o600 ||
      info.size > limit
    )
      throw new Error("Unsafe runner input file");
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw new Error("Runner input exceeds limit");
    if (info.nlink !== 1) {
      const prefix = `${basename(path)}.`;
      for (const name of readdirSync(dirname(path))) {
        if (!name.startsWith(prefix) || !/^[a-f0-9-]{36}$/.test(name.slice(prefix.length)))
          continue;
        const temporary = `${dirname(path)}/${name}`;
        const linked = openSync(
          temporary,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const candidate = fstatSync(linked);
          if (candidate.dev === info.dev && candidate.ino === info.ino) rmSync(temporary);
        } finally {
          closeSync(linked);
        }
      }
      if (fstatSync(fd).nlink !== 1) throw new Error("Unsafe runner input links");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function immutable(path: string, bytes: Buffer) {
  const temporary = `${path}.${randomUUID()}`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !privateFile(path, bytes.length).equals(bytes)
      )
        throw new Error("Runner input is immutable", { cause: error });
    }
  } finally {
    closeSync(fd);
    rmSync(temporary, { force: true });
  }
}
function storage<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (
      ["EIO", "ENOSPC", "EBUSY", "EMFILE", "ENFILE", "ENOENT"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw new RunnerInputStorageError("Runner input storage is unavailable");
    throw error;
  }
}
export function createRunnerInputStore(options: { root: string; work: RunnerWork }) {
  if (!isAbsolute(options.root)) throw new Error("Runner input root must be absolute");
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  function directory(commandId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(commandId))
      throw new Error("Invalid runner command ID");
    const fd = openSync(
      options.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = fstatSync(fd);
      if (info.uid !== process.getuid!() || (info.mode & 0o7777) !== 0o700)
        throw new Error("Unsafe runner input root");
      const path = `/proc/self/fd/${fd}/${hash(commandId)}`;
      mkdirSync(path, { recursive: true, mode: 0o700 });
      const child = openSync(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const childInfo = fstatSync(child);
        if (childInfo.uid !== process.getuid!() || (childInfo.mode & 0o7777) !== 0o700)
          throw new Error("Unsafe runner input directory");
        fsyncSync(fd);
        return child;
      } catch (error) {
        closeSync(child);
        throw error;
      }
    } finally {
      closeSync(fd);
    }
  }
  function readChunk(
    commandId: string,
    offset: number,
    file: { sizeBytes: number; sha256: string },
    names: { bytes: string; metadata: string; expected: unknown; limit: number },
  ) {
    if (
      offset % RUNNER_INPUT_CHUNK_BYTES !== 0 ||
      offset > file.sizeBytes ||
      (offset > 0 && offset === file.sizeBytes)
    )
      throw new Error("Invalid runner input range");
    return storage(() => {
      const fd = directory(commandId);
      try {
        const root = `/proc/self/fd/${fd}`;
        if (
          !privateFile(`${root}/${names.metadata}`, 262144).equals(
            Buffer.from(JSON.stringify(names.expected)),
          )
        )
          throw new Error("Runner input manifest changed");
        const contents = privateFile(`${root}/${names.bytes}`, names.limit);
        if (contents.length !== file.sizeBytes || hash(contents) !== file.sha256)
          throw new RunnerInputStorageError("Runner input storage is unavailable");
        return contents.subarray(offset, offset + RUNNER_INPUT_CHUNK_BYTES);
      } finally {
        closeSync(fd);
      }
    });
  }
  const api = {
    stagePrompt(commandId: string, prompt: string): RunnerPromptContext {
      if (typeof prompt !== "string" || Buffer.byteLength(prompt) > RUNNER_PROMPT_CONTEXT_MAX_BYTES)
        throw new Error("Runner prompt context exceeds limit");
      const bytes = Buffer.from(prompt, "utf8");
      if (bytes.toString("utf8") !== prompt) throw new Error("Invalid runner prompt context UTF-8");
      const manifest = RunnerPromptContextSchema.parse({
        sizeBytes: bytes.length,
        sha256: hash(bytes),
      });
      return storage(() => {
        const fd = directory(commandId);
        try {
          const root = `/proc/self/fd/${fd}`;
          immutable(`${root}/prompt.bytes`, bytes);
          immutable(`${root}/prompt.json`, Buffer.from(JSON.stringify(manifest)));
          fsyncSync(fd);
          return manifest;
        } finally {
          closeSync(fd);
        }
      });
    },
    readContext(
      access: { runnerId: string; runId: string; token: string },
      raw: z.infer<typeof contextRequestSchema>,
    ) {
      const input = contextRequestSchema.parse(raw);
      const authorize = () => {
        const { command } = options.work.authorize({ ...access, generation: input.generation });
        if (
          (command.type !== "run" && command.type !== "review" && command.type !== "task") ||
          command.id !== input.commandId ||
          !command.promptContext
        )
          throw new RunnerWorkFencedError("Runner prompt context assignment changed");
        return command.promptContext;
      };
      const manifest = authorize();
      const bytes = readChunk(input.commandId, input.offset, manifest, {
        bytes: "prompt.bytes",
        metadata: "prompt.json",
        expected: manifest,
        limit: RUNNER_PROMPT_CONTEXT_MAX_BYTES,
      });
      if (JSON.stringify(authorize()) !== JSON.stringify(manifest))
        throw new RunnerWorkFencedError("Runner prompt context assignment changed");
      return {
        commandId: input.commandId,
        offset: input.offset,
        sha256: hash(bytes),
        data: bytes.toString("base64"),
      };
    },
    stage(commandId: string, files: readonly RunnerInputSource[]): RunnerInputFile[] {
      if (
        files.length > 21 ||
        files.reduce((total, file) => total + file.bytes.byteLength, 0) > RUNNER_INPUT_MAX_BYTES
      )
        throw new Error("Runner input exceeds limit");
      const snapshots = files.map((file) => ({
        path: file.path,
        mimeType: file.mimeType,
        bytes: Buffer.from(file.bytes),
      }));
      const manifest = RunnerInputFilesSchema.parse(
        snapshots.map((file, id) => ({
          id,
          path: file.path,
          mimeType: file.mimeType,
          sizeBytes: file.bytes.byteLength,
          sha256: hash(file.bytes),
        })),
      );
      return storage(() => {
        const fd = directory(commandId);
        try {
          const root = `/proc/self/fd/${fd}`;
          for (const file of manifest)
            immutable(`${root}/${file.id}.bytes`, snapshots[file.id]!.bytes);
          immutable(`${root}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
          fsyncSync(fd);
          return manifest;
        } finally {
          closeSync(fd);
        }
      });
    },
    read(
      access: { runnerId: string; runId: string; token: string },
      raw: z.infer<typeof requestSchema>,
    ) {
      const input = requestSchema.parse(raw);
      const authorize = () => {
        const { command } = options.work.authorize({ ...access, generation: input.generation });
        if (
          (command.type !== "run" && command.type !== "review" && command.type !== "task") ||
          command.id !== input.commandId ||
          !command.inputFiles
        )
          throw new RunnerWorkFencedError("Runner input assignment changed");
        return command.inputFiles;
      };
      const manifest = authorize();
      const file = manifest[input.fileId];
      if (!file) throw new Error("Invalid runner input range");
      const bytes = readChunk(input.commandId, input.offset, file, {
        bytes: `${file.id}.bytes`,
        metadata: "manifest.json",
        expected: manifest,
        limit: RUNNER_INPUT_MAX_BYTES,
      });
      if (JSON.stringify(authorize()) !== JSON.stringify(manifest))
        throw new RunnerWorkFencedError("Runner input assignment changed");
      return {
        commandId: input.commandId,
        fileId: file.id,
        offset: input.offset,
        sha256: hash(bytes),
        data: bytes.toString("base64"),
      };
    },
    async fetch(request: Request, runnerId: string): Promise<Response | null> {
      const match = /^\/v1\/runs\/([^/]+)\/(inputs|context)\/read$/.exec(
        new URL(request.url).pathname,
      );
      if (!match) return null;
      try {
        const authorization = request.headers.get("authorization");
        if (
          request.method !== "POST" ||
          !authorization ||
          !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization) ||
          request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
        )
          throw new Error("Runner input grant and JSON are required");
        const input = await body(request);
        const access = {
          runnerId,
          runId: decodeURIComponent(match[1]!),
          token: authorization.slice(7),
        };
        return Response.json(
          match[2] === "context"
            ? api.readContext(access, contextRequestSchema.parse(input))
            : api.read(access, requestSchema.parse(input)),
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        return Response.json(
          { error: "Runner input request failed" },
          {
            status:
              error instanceof RunnerWorkFencedError
                ? 409
                : error instanceof RunnerInputStorageError ||
                    (error instanceof SQLiteError && [5, 6, 10, 13].includes(error.errno & 255))
                  ? 503
                  : 403,
            headers: { "cache-control": "no-store" },
          },
        );
      }
    },
  };
  return api;
}
export type RunnerInputStore = ReturnType<typeof createRunnerInputStore>;
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON is required");
  const timeout = AbortSignal.timeout(10_000);
  const cancel = () => void reader.cancel().catch(() => undefined);
  timeout.addEventListener("abort", cancel, { once: true });
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      timeout.throwIfAborted();
      request.signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) throw new Error("Runner input request exceeds limit");
      chunks.push(part.value);
    }
    timeout.throwIfAborted();
    request.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    timeout.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
