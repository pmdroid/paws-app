import { journalCaught } from "../journal";
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
import { RunnerWorkFencedError, runnerFailureStatus, type RunnerWork } from "../runner-work";
import {
  missingRunFileObject,
  SealedRunnerFileConflictError,
  type SealedRunnerFiles,
} from "../run-files";

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
      journalCaught(error, "runner-inputs.immutable.linkSync", null, "path may already exist");
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
export function createRunnerInputStore(options: {
  root: string;
  work: RunnerWork;
  remote?: SealedRunnerFiles;
}) {
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
  function range(offset: number, file: { sizeBytes: number }) {
    if (
      offset % RUNNER_INPUT_CHUNK_BYTES !== 0 ||
      offset > file.sizeBytes ||
      (offset > 0 && offset === file.sizeBytes)
    )
      throw new Error("Invalid runner input range");
  }
  function objectKey(runId: string, commandId: string, name: string, index: number) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(commandId)
    )
      throw new Error("Invalid runner command ID");
    return `runner-inputs/${runId}/${commandId}/${name}/${index}`;
  }
  async function put(
    remote: SealedRunnerFiles,
    file: { runId: string; commandId: string; name: string; digest: string },
    bytes: Buffer,
  ) {
    const count = Math.max(1, Math.ceil(bytes.length / RUNNER_INPUT_CHUNK_BYTES));
    for (let index = 0; index < count; index++) {
      const start = index * RUNNER_INPUT_CHUNK_BYTES;
      try {
        await remote.write(
          objectKey(file.runId, file.commandId, file.name, index),
          { ...file, kind: "input" },
          bytes.subarray(start, start + RUNNER_INPUT_CHUNK_BYTES),
        );
      } catch (error) {
        if (error instanceof SealedRunnerFileConflictError)
          throw new Error("Runner input is immutable", { cause: error });
        journalCaught(error, "runner-inputs.put.write", null);
        throw new RunnerInputStorageError("Runner input storage is unavailable");
      }
    }
  }
  async function remoteChunk(
    access: { runId: string },
    commandId: string,
    name: string,
    offset: number,
    file: { sizeBytes: number; sha256: string },
  ) {
    if (!options.remote) return null;
    range(offset, file);
    const key = objectKey(access.runId, commandId, name, offset / RUNNER_INPUT_CHUNK_BYTES);
    let bytes: Buffer;
    try {
      bytes = await options.remote.read(key, file.sha256);
    } catch (error) {
      if (missingRunFileObject(error)) return null;
      journalCaught(error, "runner-inputs.remoteChunk.read", null);
      throw new RunnerInputStorageError("Runner input storage is unavailable");
    }
    if (bytes.length !== Math.min(RUNNER_INPUT_CHUNK_BYTES, file.sizeBytes - offset))
      throw new RunnerInputStorageError("Runner input storage is unavailable");
    return bytes;
  }
  function readChunk(
    commandId: string,
    offset: number,
    file: { sizeBytes: number; sha256: string },
    names: { bytes: string; metadata: string; expected: unknown; limit: number },
  ) {
    range(offset, file);
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
    async stagePrompt(
      commandId: string,
      prompt: string,
      runId?: string,
    ): Promise<RunnerPromptContext> {
      if (typeof prompt !== "string" || Buffer.byteLength(prompt) > RUNNER_PROMPT_CONTEXT_MAX_BYTES)
        throw new Error("Runner prompt context exceeds limit");
      const bytes = Buffer.from(prompt, "utf8");
      if (bytes.toString("utf8") !== prompt) throw new Error("Invalid runner prompt context UTF-8");
      const manifest = RunnerPromptContextSchema.parse({
        sizeBytes: bytes.length,
        sha256: hash(bytes),
      });
      if (options.remote && runId) {
        await put(
          options.remote,
          { runId, commandId, name: "prompt", digest: manifest.sha256 },
          bytes,
        );
        return manifest;
      }
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
    async readContext(
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
      const bytes =
        (await remoteChunk(access, input.commandId, "prompt", input.offset, manifest)) ??
        readChunk(input.commandId, input.offset, manifest, {
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
    async stage(
      commandId: string,
      files: readonly RunnerInputSource[],
      runId?: string,
    ): Promise<RunnerInputFile[]> {
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
      if (options.remote && runId) {
        for (const file of manifest)
          await put(
            options.remote,
            { runId, commandId, name: String(file.id), digest: file.sha256 },
            snapshots[file.id]!.bytes,
          );
        return manifest;
      }
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
    async read(
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
      const bytes =
        (await remoteChunk(access, input.commandId, String(file.id), input.offset, file)) ??
        readChunk(input.commandId, input.offset, file, {
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
            ? await api.readContext(access, contextRequestSchema.parse(input))
            : await api.read(access, requestSchema.parse(input)),
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        journalCaught(error, "runner-inputs.fetch.get", null);
        return Response.json(
          { error: "Runner input request failed" },
          {
            status: error instanceof RunnerInputStorageError ? 503 : runnerFailureStatus(error),
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
  const cancel = () =>
    void reader.cancel().catch((caughtError1) => {
      journalCaught(caughtError1, "runner-inputs.body.cancel", null);
      return undefined;
    });
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
    await reader.cancel().catch((caughtError2) => {
      journalCaught(caughtError2, "runner-inputs.body.cancel", null);
      return undefined;
    });
    reader.releaseLock();
  }
}
