import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readStoredToken, writeStoredToken, type StoredLinearToken } from "../linear";

const MODE = 0o600;

/** Write a secret file at mode 0600. Returns false when the bytes and mode already match. */
export function writeSecretFile(path: string, body: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === body) {
    if ((statSync(path).mode & 0o777) !== MODE) chmodSync(path, MODE);
    return false;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: MODE });
  chmodSync(tmp, MODE);
  renameSync(tmp, path);
  chmodSync(path, MODE);
  return true;
}

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
