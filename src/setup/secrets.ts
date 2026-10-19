import { existsSync, statSync } from "node:fs";
import { secretModeIsPrivate } from "../credentials";
import { readStoredToken, writeStoredToken, type StoredLinearToken } from "../linear";

export { writeSecretFile } from "../credentials";

/** Store an OAuth token. A second run with the same token leaves the file in place. */
export function writeLinearOAuth(path: string, token: StoredLinearToken): boolean {
  if (existsSync(path)) {
    try {
      const existing = readStoredToken(path);
      if (
        existing !== null &&
        existing.accessToken === token.accessToken &&
        existing.refreshToken === token.refreshToken &&
        secretModeIsPrivate(statSync(path).mode)
      ) {
        return false;
      }
    } catch {
      // Unreadable token files are replaced below.
    }
  }
  writeStoredToken(path, token);
  return true;
}
