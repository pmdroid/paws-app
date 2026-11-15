import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

declare global {
  var pawsEmbeddedAssets: Record<string, string> | undefined;
}
declare const PAWS_VERSION: string;
export const buildVersion = typeof PAWS_VERSION === "string" ? PAWS_VERSION : null;
export const compiled = () => globalThis.pawsEmbeddedAssets !== undefined;

const extracted = new Set<string>();

export function assetPath(
  name: string,
  embedded = globalThis.pawsEmbeddedAssets,
  home = process.env["PAWS_HOME"] ?? join(homedir(), ".paws"),
): string {
  if (!embedded) return join(import.meta.dir, "../..", name);
  const root = join(home, "cache", "assets", Bun.hash(JSON.stringify(embedded)).toString(16));
  if (extracted.has(root)) return join(root, name);
  for (const [relative, source] of Object.entries(embedded)) {
    const target = join(root, relative);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, readFileSync(source), { mode: 0o600 });
    renameSync(temporary, target);
  }
  extracted.add(root);
  return join(root, name);
}

export function childArgs(name: "ask-team-mcp" | "process-anchor", source: string): string[] {
  return compiled() ? [`__${name}`] : ["--no-env-file", "--config=/dev/null", source];
}
