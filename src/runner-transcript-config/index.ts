import { S3Client } from "bun";
import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { decodeSecretEnvelope, writeSecretFile } from "../credentials";
import {
  createLocalRunnerTranscriptObjects,
  createS3RunnerTranscriptObjects,
} from "../runner-transcripts";

const FILE = "runner-transcript-storage.json";
const MAX_BYTES = 65_536;
const FAILURE = "Runner transcript storage configuration is missing or invalid.";
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

export function loadRunnerTranscriptObjects(home: string) {
  return withSecrets(home, false, (directory) => {
    const encrypted = readProtected(directory, FILE, MAX_BYTES)!.toString("utf8");
    if (!encrypted.startsWith("paws-envelope-v1\n")) throw new Error();
    const key = readProtected(directory, ".envelope-key", 32)!;
    if (key.length !== 32) throw new Error();
    const config = schema.parse(JSON.parse(decodeSecretEnvelope(FILE, encrypted, key)));
    if ("kind" in config)
      return createLocalRunnerTranscriptObjects(join(home, "runner-transcripts"));
    const client = new S3Client({ ...config, sessionToken: config.sessionToken ?? "" });
    const token = new URL(client.presign("paws-config-check")).searchParams.get(
      "X-Amz-Security-Token",
    );
    if (token !== (config.sessionToken ?? null)) throw new Error();
    return createS3RunnerTranscriptObjects({ client, bucket: config.bucket });
  });
}

export function configureRunnerTranscriptStorage(home: string, text: string): void {
  try {
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error();
    const config = schema.parse(JSON.parse(text));
    withSecrets(home, true, (directory) => {
      const existing = readProtected(directory, FILE, MAX_BYTES, true);
      const key = readProtected(directory, ".envelope-key", 32, true);
      if ((key !== null && key.length !== 32) || (existing !== null && key === null))
        throw new Error();
      if (existing !== null) decodeSecretEnvelope(FILE, existing.toString("utf8"), key!);
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
    configureRunnerTranscriptStorage(home, Buffer.concat(chunks).toString("utf8"));
    console.log("Runner transcript storage configured.");
    return 0;
  } catch {
    console.error(FAILURE);
    return 1;
  }
}

function withSecrets<T>(home: string, create: boolean, action: (directory: string) => T): T {
  let homeFd: number | undefined;
  let secretsFd: number | undefined;
  try {
    if (!isAbsolute(home)) throw new Error();
    if (create) mkdirSync(home, { recursive: true, mode: 0o700 });
    homeFd = openDirectory(home);
    const secrets = `/proc/self/fd/${homeFd}/secrets`;
    if (create) {
      try {
        mkdirSync(secrets, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    secretsFd = openDirectory(secrets);
    return action(`/proc/self/fd/${secretsFd}`);
  } catch {
    throw new Error(FAILURE);
  } finally {
    if (secretsFd !== undefined) closeSync(secretsFd);
    if (homeFd !== undefined) closeSync(homeFd);
  }
}

function openDirectory(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
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
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
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
