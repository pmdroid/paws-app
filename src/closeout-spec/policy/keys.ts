import { decodeUtf8, isRecord, tryParseYamlValue } from "./document";
import { repoPath } from "./paths";
import { PUBLIC_POLICY_PATH } from "./resolve";

/**
 * Every key the policy files write, as a schema path: `ci` on a check is `items[].ci`, a key of
 * `retry` is `retry.scope`, a top-level key is its name. Reads the entry and the files it
 * imports, without validating them, so a key this Paws does not know is listed too.
 */
export function policyKeys(files: ReadonlyMap<string, Uint8Array>): string[] {
  const keys = new Set<string>();
  const pending = [PUBLIC_POLICY_PATH];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    const bytes = files.get(path);
    const text = bytes === undefined ? undefined : decodeUtf8(bytes);
    const value = text === undefined ? undefined : tryParseYamlValue(text);
    if (!isRecord(value)) continue;
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      if (Array.isArray(entry)) {
        for (const element of entry) {
          if (!isRecord(element)) continue;
          for (const inner of Object.keys(element)) keys.add(`${key}[].${inner}`);
          if (key === "imports" && typeof element.path === "string") {
            const imported = repoPath(element.path);
            if (imported !== undefined) pending.push(imported);
          }
        }
      } else if (isRecord(entry)) {
        for (const inner of Object.keys(entry)) keys.add(`${key}.${inner}`);
      }
    }
  }
  return [...keys].sort();
}
