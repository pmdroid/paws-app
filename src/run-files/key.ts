import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readSecretFile, writeSecretFile } from "../credentials";
import { RUN_FILE_KINDS, type RunFileKind } from "./kinds";

/**
 * The kind's 32-byte key in `~/.paws/secrets` (`agent-session.key` or `runner-transcript.key`),
 * created on first use. It never leaves Paws.
 */
export function loadRunFileKey(kind: RunFileKind, path: string): Buffer {
  let text = readSecretFile(path);
  if (text === null) {
    try {
      writeSecretFile(path, randomBytes(32).toString("base64"), true);
    } catch (error) {
      if (readSecretFile(path) === null) throw error;
    }
    text = readSecretFile(path);
  }
  const key = Buffer.from(text ?? "", "base64");
  if (key.length !== 32 || key.toString("base64") !== text)
    throw new Error(`${RUN_FILE_KINDS[kind].title} key is invalid.`);
  return key;
}

/** Recorded with each chunk, so a chunk sealed under another key is refused before decrypting. */
export function runFileKeyId(kind: RunFileKind, key: Buffer) {
  return createHash("sha256").update(RUN_FILE_KINDS[kind].keyContext).update(key).digest("hex");
}

export type RunFileBinding = { runId: string; generation: number; offset: number; sha256: string };

function additionalData(binding: RunFileBinding) {
  return Buffer.from(
    `${binding.runId}|${binding.generation}|${binding.offset}|${binding.sha256}`,
    "utf8",
  );
}

/** `nonce | tag | ciphertext`, bound to the chunk's run, generation, offset and plaintext hash. */
export function sealRunFileChunk(key: Buffer, binding: RunFileBinding, plaintext: Uint8Array) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(additionalData(binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function openRunFileChunk(key: Buffer, binding: RunFileBinding, sealed: Uint8Array) {
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (bytes.length < 28) throw new Error("Run file chunk is truncated.");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(additionalData(binding));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}
