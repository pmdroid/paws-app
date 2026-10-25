import { existsSync } from "node:fs";
import { join } from "node:path";
import { readSecretFile } from "../credentials";
import { pawsPaths } from "./paths";

/** File name of the exe.dev API token under `~/.paws/secrets`. */
export const EXE_DEV_TOKEN_FILE = "exe-dev-token";

export function exeDevTokenPath(home: string): string {
  return join(pawsPaths(home).secretsDir, EXE_DEV_TOKEN_FILE);
}

/**
 * The exe.dev bearer token, trimmed, or null when the file is absent or empty.
 * Throws a message without the token when the file cannot be decrypted.
 */
export function readExeDevToken(home: string, migrate = true): string | null {
  const text = readSecretFile(exeDevTokenPath(home), migrate);
  if (text === null) return null;
  const token = text.trim();
  return token.length > 0 ? token : null;
}

export type ExeDevTokenStatus = "absent" | "empty" | "readable" | "unreadable";

/** Whether the token file is present and readable. Never returns the token and never migrates. */
export function exeDevTokenStatus(home: string): ExeDevTokenStatus {
  if (!existsSync(exeDevTokenPath(home))) return "absent";
  try {
    return readExeDevToken(home, false) === null ? "empty" : "readable";
  } catch {
    return "unreadable";
  }
}
