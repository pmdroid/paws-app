import { randomBytes } from "node:crypto";
import { readSecretFile, writeSecretFile } from "./files";

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
