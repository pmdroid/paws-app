import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readSecretFile, writeSecretFile } from "../credentials";

export const AGENT_SESSION_KEY_FILE = "agent-session.key";

/** The 32-byte snapshot key in `~/.paws/secrets`, created on first use. It never leaves Paws. */
export function loadAgentSessionKey(path: string): Buffer {
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
    throw new Error("Agent session key is invalid.");
  return key;
}

export function agentSessionKeyId(key: Buffer) {
  return createHash("sha256").update("paws-agent-session-key\0").update(key).digest("hex");
}

type Binding = { runId: string; generation: number; offset: number; sha256: string };

function additionalData(binding: Binding) {
  return Buffer.from(
    `${binding.runId}|${binding.generation}|${binding.offset}|${binding.sha256}`,
    "utf8",
  );
}

/** `nonce | tag | ciphertext`, bound to the chunk's run, generation, offset and plaintext hash. */
export function sealAgentSessionChunk(key: Buffer, binding: Binding, plaintext: Uint8Array) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(additionalData(binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function openAgentSessionChunk(key: Buffer, binding: Binding, sealed: Uint8Array) {
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (bytes.length < 28) throw new Error("Agent session chunk is truncated.");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(additionalData(binding));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}
