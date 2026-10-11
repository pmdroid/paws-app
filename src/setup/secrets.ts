import { existsSync, statSync } from "node:fs";
import { readStoredToken, writeStoredToken, type StoredLinearToken } from "../linear";

const MODE = 0o600;

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
        (statSync(path).mode & 0o777) === MODE
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
