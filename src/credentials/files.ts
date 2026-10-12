import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const PREFIX = "paws-envelope-v1\n";
const KEY_FILE = ".envelope-key";

export function readSecretFile(path: string, migrate = true): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (!text.startsWith(PREFIX)) {
    if (migrate) writeSecretFile(path, text);
    return text;
  }
  try {
    const envelope = JSON.parse(text.slice(PREFIX.length)) as { key: string; value: string };
    const key = readFileSync(join(dirname(path), KEY_FILE));
    if (key.length !== 32) throw new Error();
    const context = Buffer.from(basename(path));
    const dataKey = decrypt(key, envelope.key, context);
    return decrypt(dataKey, envelope.value, context).toString("utf8");
  } catch {
    throw new Error(
      "Could not decrypt Paws credentials. Restore the envelope key and secret together.",
    );
  }
}

export function writeSecretFile(path: string, value: string, exclusive = false): boolean {
  if (existsSync(path)) {
    if (exclusive) throw new Error("Paws credential file already exists.");
    const current = readFileSync(path, "utf8");
    if (current.startsWith(PREFIX) && readSecretFile(path, false) === value) {
      chmodSync(path, 0o600);
      return false;
    }
  }
  const key = envelopeKey(dirname(path));
  const dataKey = randomBytes(32);
  const context = Buffer.from(basename(path));
  const envelope = {
    key: encrypt(key, dataKey, context),
    value: encrypt(dataKey, Buffer.from(value), context),
  };
  atomicWrite(path, PREFIX + JSON.stringify(envelope), exclusive);
  return true;
}

function envelopeKey(dir: string): Buffer {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, KEY_FILE);
  if (!existsSync(path)) {
    const temporary = join(dir, `.key-${randomBytes(16).toString("hex")}`);
    try {
      atomicWrite(temporary, randomBytes(32));
      try {
        linkSync(temporary, path);
        syncDirectory(dir);
      } catch (error) {
        if (!existsSync(path)) throw error;
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error("Paws envelope key is invalid.");
  return key;
}

function encrypt(key: Buffer, value: Buffer, context: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(context);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
}

function decrypt(key: Buffer, value: string, context: Buffer): Buffer {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(context);
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}

function atomicWrite(path: string, value: string | Buffer, exclusive = false): void {
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, value);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
