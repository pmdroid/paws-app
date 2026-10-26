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
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertNonSecretArtifactPath, type ArtifactSnapshot } from "../acp";
import {
  RUNNER_ARTIFACT_COUNT_LIMIT,
  RunnerArtifactSchema,
  RunnerArtifactChunkSchema,
  type RunnerArtifact,
  type RunnerArtifactChunk,
} from "../runner-protocol";
import { RunnerWorkFencedError, type RunnerWork } from "../runner-work";

export const RUNNER_ARTIFACT_CHUNK_BYTES = 524288;
/** An authorized upload Paws will not keep. The message is safe to show the runner. */
export class RunnerArtifactRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerArtifactRejectedError";
  }
}
function hash(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}
function privateRead(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o7777) !== 0o600 ||
      info.size > limit
    )
      throw new Error("Unsafe runner artifact file");
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw new Error("Runner artifact exceeds limit");
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
        !privateRead(path, bytes.length).equals(bytes)
      )
        throw new Error("Runner artifact is immutable", { cause: error });
      journalCaught(error, "runner-artifacts.immutable.linkSync", null, "path may already exist");
    }
  } finally {
    closeSync(fd);
    rmSync(temporary, { force: true });
  }
}
export function createRunnerArtifactStore(options: { root: string; work: RunnerWork }) {
  if (!isAbsolute(options.root)) throw new Error("Runner artifact root must be absolute");
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  function directory(commandId: string) {
    const root = openSync(
      options.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let fd: number | undefined;
    try {
      const info = fstatSync(root);
      if (info.uid !== process.getuid!() || (info.mode & 0o7777) !== 0o700)
        throw new Error("Unsafe runner artifact root");
      const path = `/proc/self/fd/${root}/${hash(commandId)}`;
      mkdirSync(path, { mode: 0o700, recursive: true });
      fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const child = fstatSync(fd);
      if (child.uid !== process.getuid!() || (child.mode & 0o7777) !== 0o700)
        throw new Error("Unsafe runner artifact directory");
      fsyncSync(root);
      return fd;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      throw error;
    } finally {
      closeSync(root);
    }
  }
  const api = {
    upload(input: { runnerId: string; runId: string; token: string; chunk: RunnerArtifactChunk }) {
      const value = RunnerArtifactChunkSchema.parse(input.chunk);
      assertNonSecretArtifactPath(value.artifact.path);
      const { command } = options.work.authorize({ ...input, generation: value.generation });
      const bytes = Buffer.from(value.data, "base64");
      const expected = Math.min(
        RUNNER_ARTIFACT_CHUNK_BYTES,
        value.artifact.sizeBytes - value.index * RUNNER_ARTIFACT_CHUNK_BYTES,
      );
      if (
        expected < 0 ||
        (value.index > 0 && expected === 0) ||
        bytes.length !== expected ||
        bytes.toString("base64") !== value.data
      )
        throw new Error("Runner artifact chunk is invalid");
      const fd = directory(command.id);
      try {
        const root = `/proc/self/fd/${fd}`;
        const metadata = `${value.artifact.id}.json`;
        const names = readdirSync(root);
        if (
          !names.includes(metadata) &&
          names.filter((name) => name.endsWith(".json")).length >= RUNNER_ARTIFACT_COUNT_LIMIT
        )
          throw new RunnerArtifactRejectedError(
            `Paws keeps at most ${RUNNER_ARTIFACT_COUNT_LIMIT} artifacts per run`,
          );
        immutable(join(root, metadata), Buffer.from(JSON.stringify(value.artifact)));
        immutable(join(root, `${value.artifact.id}.${value.index}.bytes`), bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { ok: true };
    },
    snapshot(runId: string, generation: number, descriptor: RunnerArtifact): ArtifactSnapshot {
      const artifact = RunnerArtifactSchema.parse(descriptor);
      const { command } = options.work.current(runId, generation);
      const fd = directory(command.id);
      try {
        const root = `/proc/self/fd/${fd}`;
        if (
          !privateRead(join(root, `${artifact.id}.json`), 8192).equals(
            Buffer.from(JSON.stringify(artifact)),
          )
        )
          throw new Error("Runner artifact metadata changed");
        const chunks: Buffer[] = [];
        const count = Math.max(1, Math.ceil(artifact.sizeBytes / RUNNER_ARTIFACT_CHUNK_BYTES));
        for (let index = 0; index < count; index++) {
          const bytes = privateRead(
            join(root, `${artifact.id}.${index}.bytes`),
            RUNNER_ARTIFACT_CHUNK_BYTES,
          );
          if (
            bytes.length !==
            Math.min(
              RUNNER_ARTIFACT_CHUNK_BYTES,
              artifact.sizeBytes - index * RUNNER_ARTIFACT_CHUNK_BYTES,
            )
          )
            throw new Error("Runner artifact chunk changed");
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (hash(bytes) !== artifact.sha256) throw new Error("Runner artifact content changed");
        return {
          path: artifact.path,
          displayName: artifact.displayName,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          bytes: new Blob([bytes], { type: artifact.mimeType }),
        };
      } finally {
        closeSync(fd);
      }
    },
    async fetch(request: Request, runnerId: string): Promise<Response | null> {
      const match = /^\/v1\/runs\/([^/]+)\/artifacts$/.exec(new URL(request.url).pathname);
      if (!match || request.method !== "POST") return null;
      try {
        const authorization = request.headers.get("authorization");
        if (
          !authorization ||
          !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization) ||
          request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
        )
          throw new Error("Artifact grant and JSON are required");
        const chunk = RunnerArtifactChunkSchema.parse(await body(request));
        return Response.json(
          api.upload({
            runnerId,
            runId: decodeURIComponent(match[1]!),
            token: authorization.slice(7),
            chunk,
          }),
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        journalCaught(error, "runner-artifacts.fetch.get", null);
        // The runner drops a rejected artifact and keeps the run; every other refusal stays fatal.
        if (error instanceof RunnerArtifactRejectedError)
          return Response.json(
            { error: error.message },
            { status: 422, headers: { "cache-control": "no-store" } },
          );
        return Response.json(
          { error: "Runner artifact access is denied" },
          {
            status: error instanceof RunnerWorkFencedError ? 409 : 403,
            headers: { "cache-control": "no-store" },
          },
        );
      }
    },
  };
  return api;
}
export type RunnerArtifactStore = ReturnType<typeof createRunnerArtifactStore>;

async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON is required");
  const timeout = AbortSignal.timeout(10_000);
  const cancel = () =>
    void reader.cancel().catch((caughtError1) => {
      journalCaught(caughtError1, "runner-artifacts.body.cancel", null);
      return undefined;
    });
  timeout.addEventListener("abort", cancel, { once: true });
  request.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      timeout.throwIfAborted();
      request.signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 737_280) throw new Error("Runner artifact request is too large");
      chunks.push(part.value);
    }
    timeout.throwIfAborted();
    request.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    timeout.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch((caughtError2) => {
      journalCaught(caughtError2, "runner-artifacts.body.cancel", null);
      return undefined;
    });
    reader.releaseLock();
  }
}
