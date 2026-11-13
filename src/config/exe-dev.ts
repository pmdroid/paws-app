import { journalCaught } from "../journal";
import { join } from "node:path";
import { readSecretFile, secretFileExists } from "../credentials";
import { pawsPaths } from "./paths";

export const EXE_DEV_TOKEN_FILE = "exe-dev-token";

export function exeDevTokenPath(home: string): string {
  return join(pawsPaths(home).secretsDir, EXE_DEV_TOKEN_FILE);
}

export function readExeDevToken(home: string, migrate = true): string | null {
  const text = readSecretFile(exeDevTokenPath(home), migrate);
  if (text === null) return null;
  const token = text.trim();
  return token.length > 0 ? token : null;
}

export type ExeDevTokenStatus = "absent" | "empty" | "readable" | "unreadable";

export function exeDevTokenStatus(home: string): ExeDevTokenStatus {
  if (!secretFileExists(exeDevTokenPath(home))) return "absent";
  try {
    return readExeDevToken(home, false) === null ? "empty" : "readable";
  } catch (caughtError1) {
    journalCaught(caughtError1, "exe-dev.exeDevTokenStatus.readExeDevToken", null);
    return "unreadable";
  }
}
