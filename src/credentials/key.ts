import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { readSecretFile, saveSecret, writeSecretFile } from "./files";

export function loadSecretKey(path: string, title: string): Buffer {
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
    throw new Error(`${title} key is invalid.`);
  return key;
}

export async function storeSecretKeys(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    if (readSecretFile(path) === null)
      await saveSecret(path, randomBytes(32).toString("base64"), true);
    loadSecretKey(path, basename(path));
  }
}
