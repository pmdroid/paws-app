import { journalCaught } from "../journal";
import { S3Client } from "bun";
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  decodeSecretEnvelope,
  openSecretAt,
  readSecretFile,
  saveSecret,
  storedSecrets,
  writeSecretFile,
} from "../credentials";
import { agentSessionObjectKey, createLocalAgentSessionObjects } from "../agent-sessions";
import { sealedRunFileChunkObjects, type Db } from "../db";
import { migrateRunFileObjects, type RunFileObjects } from "../run-files";
import {
  createLocalRunnerTranscriptObjects,
  createS3RunnerTranscriptObjects,
  runnerTranscriptObjectKey,
  withLocalRunnerTranscriptFallback,
} from "../runner-transcripts";

const FILE = "runner-transcript-storage.json";
const MAX_BYTES = 65_536;
const FAILURE = "Runner transcript storage configuration is missing or invalid.";
const ENV = {
  bucket: "PAWS_S3_BUCKET",
  endpoint: "PAWS_S3_ENDPOINT",
  region: "PAWS_S3_REGION",
  accessKeyId: "PAWS_S3_ACCESS_KEY_ID",
  secretAccessKey: "PAWS_S3_SECRET_ACCESS_KEY",
  sessionToken: "PAWS_S3_SESSION_TOKEN",
};
const secret = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value && withoutControls(value));
const s3Schema = z
  .object({
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    endpoint: z
      .string()
      .max(2_048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            value.trim() === value &&
            url.protocol === "https:" &&
            url.hostname !== "" &&
            url.username === "" &&
            url.password === "" &&
            !/[?#\s]/.test(value) &&
            withoutControls(value)
          );
        } catch {
          journalCaught(FAILURE, "runner-transcript-config.validateEndpoint", null);
          return false;
        }
      }),
    region: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
    accessKeyId: secret(256),
    secretAccessKey: secret(4_096),
    sessionToken: secret(16_384).optional(),
  })
  .strict();
const schema = z.union([z.strictObject({ kind: z.literal("local") }), s3Schema]);

const fromEnvironment = () => Object.values(ENV).some((name) => process.env[name] !== undefined);
const environmentConfig = () =>
  Object.fromEntries(Object.entries(ENV).map(([key, name]) => [key, process.env[name]]));

/** The transcript S3 bucket from `PAWS_S3_*` or the stored configuration, or null when transcripts are stored locally. */
export function loadRunnerTranscriptS3(home: string): { client: S3Client; bucket: string } | null {
  try {
    return s3From(currentText(home));
  } catch {
    throw new Error(FAILURE);
  }
}

function currentText(home: string): string | null {
  return fromEnvironment() ? JSON.stringify(environmentConfig()) : storedText(home);
}

function storedText(home: string): string | null {
  if (storedSecrets() !== null) return readSecretFile(join(home, "secrets", FILE), false);
  return withSecrets(home, false, (directory) => {
    const stored = readProtected(directory, FILE, MAX_BYTES, true);
    if (stored === null) return null;
    const encrypted = stored.toString("utf8");
    if (!encrypted.startsWith("paws-envelope-v1\n")) throw new Error();
    return process.env.PAWS_SECRET_KEY
      ? openSecretAt(join(directory, FILE), encrypted)
      : decodeSecretEnvelope(FILE, encrypted, readProtected(directory, ".envelope-key", 32)!);
  });
}

function s3From(plain: string | null) {
  if (plain === null) return null;
  const config = schema.parse(JSON.parse(plain));
  if ("kind" in config) return null;
  const client = new S3Client({ ...config, sessionToken: config.sessionToken ?? "" });
  const token = new URL(client.presign("paws-config-check")).searchParams.get(
    "X-Amz-Security-Token",
  );
  if (token !== (config.sessionToken ?? null)) throw new Error();
  return { client, bucket: config.bucket };
}

export class RunnerStorageSettingsError extends Error {}

export function runnerStorageSettings(home: string) {
  const environment = fromEnvironment();
  const text = environment ? null : storedText(home);
  const parsed = text === null ? null : parseStorage(text);
  const config: Partial<z.infer<typeof s3Schema>> | null = environment
    ? environmentConfig()
    : parsed === null || "kind" in parsed
      ? null
      : parsed;
  return {
    kind: config === null ? ("local" as const) : ("s3" as const),
    bucket: config?.bucket ?? null,
    endpoint: config?.endpoint ?? null,
    region: config?.region ?? null,
    accessKeyId: config?.accessKeyId ?? null,
    hasSecretAccessKey: config?.secretAccessKey !== undefined,
    hasSessionToken: config?.sessionToken !== undefined,
    source: environment
      ? ("environment" as const)
      : text === null
        ? ("default" as const)
        : ("settings" as const),
  };
}

const inputSchema = z.strictObject({
  kind: z.enum(["local", "s3"]),
  bucket: z.string().optional(),
  endpoint: z.string().optional(),
  region: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  sessionToken: z.string().nullable().optional(),
});

function submittedText(home: string, input: unknown): string {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  const { kind, secretAccessKey, sessionToken, ...fields } = parsed.data;
  const previous = currentText(home);
  const stored = previous === null ? {} : (JSON.parse(previous) as Record<string, unknown>);
  const config =
    kind === "local"
      ? { kind }
      : {
          ...fields,
          secretAccessKey: secretAccessKey ?? stored.secretAccessKey,
          sessionToken: sessionToken === null ? undefined : (sessionToken ?? stored.sessionToken),
        };
  const result = (kind === "local" ? schema : s3Schema).safeParse(config);
  if (!result.success) throw invalid(result.error);
  const text = JSON.stringify(result.data);
  try {
    s3From(text);
  } catch {
    throw new RunnerStorageSettingsError("The session token is not valid for S3.");
  }
  return text;
}

function invalid(error: z.ZodError) {
  const fields = [...new Set(error.issues.map((issue) => issue.path.join(".") || "body"))];
  return new RunnerStorageSettingsError(`Invalid storage settings: ${fields.join(", ")}.`);
}

export async function saveRunnerStorageSettings(home: string, input: unknown): Promise<boolean> {
  if (fromEnvironment())
    throw new RunnerStorageSettingsError(
      "Storage is set by PAWS_S3_* environment variables on this host.",
    );
  const text = submittedText(home, input);
  if (text !== storedText(home)) await saveStorage(home, text);
  return startedWith !== undefined && storageKey(text) !== startedWith;
}

let startedWith: string | undefined;

function storageKey(text: string | null): string {
  return text === null || "kind" in parseStorage(text) ? "local" : text;
}

async function saveStorage(home: string, text: string): Promise<void> {
  if (storedSecrets() === null) configureRunnerTranscriptStorage(home, text);
  else await saveSecret(join(home, "secrets", FILE), JSON.stringify(parseStorage(text)));
}

export async function checkRunnerStorageSettings(
  home: string,
  input: unknown,
  objects: (s3: {
    client: S3Client;
    bucket: string;
  }) => RunFileObjects = createS3RunnerTranscriptObjects,
): Promise<void> {
  const text = input === undefined ? currentText(home) : submittedText(home, input);
  let s3: ReturnType<typeof s3From>;
  try {
    s3 = s3From(text);
  } catch {
    throw new RunnerStorageSettingsError(FAILURE);
  }
  if (s3 === null)
    throw new RunnerStorageSettingsError("Storage is local; there is no bucket to check.");
  const store = objects(s3);
  const key = `paws-storage-check/${randomUUID()}`;
  const bytes = new TextEncoder().encode("paws storage check");
  await store.write(key, bytes);
  let read: Uint8Array;
  try {
    read = await store.read(key);
  } finally {
    await store.delete(key);
  }
  if (!Buffer.from(read).equals(Buffer.from(bytes)))
    throw new Error("The test object read back differently from what was written.");
}

/**
 * Transcript chunks: `objects` reads the local chunk when one exists and the S3 bucket otherwise,
 * and writes to the bucket when one is configured. `stores` lists each store on its own.
 */
export function loadRunnerTranscriptStores(home: string) {
  const local = createLocalRunnerTranscriptObjects(join(home, "runner-transcripts"));
  const s3 = loadRunnerTranscriptS3(home);
  startedWith ??= storageKey(currentText(home));
  if (s3 === null) return { objects: local, stores: [local] };
  const remote = createS3RunnerTranscriptObjects(s3);
  return { objects: withLocalRunnerTranscriptFallback(local, remote), stores: [local, remote] };
}

export function loadRunnerTranscriptObjects(home: string) {
  return loadRunnerTranscriptStores(home).objects;
}

export async function migrateRunnerStorage(options: {
  home: string;
  store: Db;
  deleteLocal: boolean;
  remote?: RunFileObjects;
}) {
  const s3 = options.remote ? null : loadRunnerTranscriptS3(options.home);
  const remote = options.remote ?? (s3 && createS3RunnerTranscriptObjects(s3));
  if (!remote) throw new Error("Runner storage is not configured for S3.");
  const chunks = await sealedRunFileChunkObjects(options.store);
  return {
    transcripts: await migrateRunFileObjects(
      chunks.transcript.map(runnerTranscriptObjectKey),
      createLocalRunnerTranscriptObjects(join(options.home, "runner-transcripts")),
      remote,
      options.deleteLocal,
    ),
    agentSessions: await migrateRunFileObjects(
      chunks.agentSession.map(agentSessionObjectKey),
      createLocalAgentSessionObjects(join(options.home, "agent-sessions")),
      remote,
      options.deleteLocal,
    ),
  };
}

function parseStorage(text: string) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error();
  return schema.parse(JSON.parse(text));
}

export function configureRunnerTranscriptStorage(home: string, text: string): void {
  try {
    const config = parseStorage(text);
    withSecrets(home, true, (directory) => {
      const existing = readProtected(directory, FILE, MAX_BYTES, true);
      if (existing !== null && process.env.PAWS_SECRET_KEY)
        openSecretAt(join(directory, FILE), existing.toString("utf8"));
      else {
        const key = readProtected(directory, ".envelope-key", 32, true);
        if ((key !== null && key.length !== 32) || (existing !== null && key === null))
          throw new Error();
        if (existing !== null) decodeSecretEnvelope(FILE, existing.toString("utf8"), key!);
      }
      writeSecretFile(join(directory, FILE), JSON.stringify(config));
    });
  } catch {
    throw new Error(FAILURE);
  }
}

export async function runRunnerTranscriptStorageCli(args: string[], home: string): Promise<number> {
  try {
    if (args.length !== 1 || args[0] !== "configure") throw new Error();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BYTES) throw new Error();
      chunks.push(bytes);
    }
    await saveStorage(home, Buffer.concat(chunks).toString("utf8"));
    console.log("Runner transcript storage configured.");
    return 0;
  } catch {
    journalCaught(FAILURE, "runner-transcript-config.runRunnerTranscriptStorageCli", null);

    return 1;
  }
}

function withSecrets<T>(home: string, create: boolean, action: (directory: string) => T): T | null {
  let homeFd: number | null = null;
  let secretsFd: number | null = null;
  try {
    if (!isAbsolute(home)) throw new Error();
    if (create) mkdirSync(home, { recursive: true, mode: 0o700 });
    homeFd = openDirectory(home, !create);
    if (homeFd === null) return null;
    const secrets = `/proc/self/fd/${homeFd}/secrets`;
    if (create) {
      try {
        mkdirSync(secrets, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        journalCaught(
          error,
          "runner-transcript-config.withSecrets.mkdirSync",
          null,
          "path may already exist",
        );
      }
    }
    secretsFd = openDirectory(secrets, !create);
    if (secretsFd === null) return null;
    return action(`/proc/self/fd/${secretsFd}`);
  } catch {
    throw new Error(FAILURE);
  } finally {
    if (secretsFd !== null) closeSync(secretsFd);
    if (homeFd !== null) closeSync(homeFd);
  }
}

function openDirectory(path: string, optional: boolean): number | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") {
      journalCaught(
        error,
        "runner-transcript-config.openDirectory.openSync",
        null,
        "optional file may be absent",
      );
      return null;
    }
    throw error;
  }
  const info = fstatSync(fd);
  if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o7777) !== 0o700) {
    closeSync(fd);
    throw new Error();
  }
  return fd;
}

function readProtected(
  directory: string,
  name: string,
  max: number,
  optional = false,
): Buffer | null {
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        join(directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") {
        journalCaught(
          error,
          "runner-transcript-config.readProtected.openSync",
          null,
          "optional file may be absent",
        );
        return null;
      }
      throw error;
    }
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid!() ||
      ![0o400, 0o600].includes(info.mode & 0o7777) ||
      info.size > max
    )
      throw new Error();
    const bytes = Buffer.alloc(max + 1);
    let size = 0;
    while (size <= max) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) return bytes.subarray(0, size);
      size += count;
    }
    throw new Error();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function withoutControls(value: string): boolean {
  return [...value].every(
    (character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
  );
}
