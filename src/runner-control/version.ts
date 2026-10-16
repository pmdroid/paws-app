import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const SOURCE_ROOT = resolve(import.meta.dir, "../..");

/**
 * The server's release version: `X.Y.Z` when the source root resolves to
 * `…/releases/X.Y.Z` (for example `/opt/paws/current`), otherwise null.
 */
export function serverVersion(root = SOURCE_ROOT): string | null {
  try {
    const target = realpathSync(root);
    const name = basename(target);
    return basename(dirname(target)) === "releases" &&
      /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(name)
      ? name
      : null;
  } catch {
    return null;
  }
}
