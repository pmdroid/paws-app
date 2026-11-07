import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  forgetRunnerFileObject,
  immediate,
  prunableRunnerFileObjects,
  recordRunnerFileObject,
  type RunnerFileObject,
} from "../db";
import { journalCaught } from "../journal";
import { RUN_FILE_CHUNK_BYTES } from "./kinds";
import type { RunFileObjects } from "./objects";

export const RUNNER_FILE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class SealedRunnerFileConflictError extends Error {}

export type SealedRunnerFile = Omit<RunnerFileObject, "key" | "sha256" | "createdAt">;

function additionalData(key: string, digest: string) {
  return Buffer.from(`paws-runner-file\0${key}\0${digest}`, "utf8");
}

export function createSealedRunnerFiles(options: {
  db: Database;
  objects: RunFileObjects;
  key: Buffer;
  now?: () => number;
}) {
  const { db, objects, key } = options;
  const now = options.now ?? Date.now;
  if (key.length !== 32) throw new Error("Runner file key is invalid.");
  return {
    async write(objectKey: string, file: SealedRunnerFile, bytes: Uint8Array, admit?: () => void) {
      if (bytes.byteLength > RUN_FILE_CHUNK_BYTES)
        throw new Error("Runner file chunk is too large");
      immediate(db, () => {
        admit?.();
        const sha256 = createHmac("sha256", key).update(bytes).digest("hex");
        if (!recordRunnerFileObject(db, { ...file, key: objectKey, sha256, createdAt: now() }))
          throw new SealedRunnerFileConflictError("Runner file is immutable");
      });
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(additionalData(objectKey, file.digest));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      await objects.write(objectKey, Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]));
    },
    async read(objectKey: string, digest: string) {
      const stored = Buffer.from(await objects.read(objectKey));
      if (stored.length < 28) throw new Error("Runner file chunk is truncated");
      const decipher = createDecipheriv("aes-256-gcm", key, stored.subarray(0, 12));
      decipher.setAAD(additionalData(objectKey, digest));
      decipher.setAuthTag(stored.subarray(12, 28));
      return Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]);
    },
    async prune() {
      let pruned = 0;
      for (const objectKey of prunableRunnerFileObjects(db, now() - RUNNER_FILE_RETENTION_MS)) {
        try {
          await objects.delete(objectKey);
          forgetRunnerFileObject(db, objectKey);
          pruned++;
        } catch (error) {
          journalCaught(error, "run-files.sealed.prune", null);
        }
      }
      return pruned;
    },
  };
}
export type SealedRunnerFiles = ReturnType<typeof createSealedRunnerFiles>;
