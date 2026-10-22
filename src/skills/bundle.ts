import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Skill files keyed by their path inside the skill folder, `/`-separated. */
export type SkillFiles = Map<string, Uint8Array>;

export type SkillBundle = { path: string; sha256: string; sizeBytes: number };

/** Bundles over this are refused, and so are sources whose files add up to more. */
export const SKILL_BUNDLE_LIMIT = 50 * 1024 * 1024;

export const SKILL_BUNDLE_FILE = "skill.tar.gz";

/** A refused source or request. The message is safe to show the person who added the skill. */
export class SkillError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function validSkillName(name: string): boolean {
  return NAME.test(name) && !name.includes("..");
}

/** A relative path that stays inside the skill folder, or null. */
export function skillPath(path: string): string | null {
  const parts = path.replaceAll("\\", "/").split("/");
  if (parts[0] === "" && parts.length > 1) return null;
  const kept = parts.filter((part) => part !== "" && part !== ".");
  if (kept.length === 0 || kept.some((part) => part === ".." || part.includes("\0"))) return null;
  return kept.join("/");
}

/** Keep the files under `subfolder`, re-rooted there. Paths that escape are dropped. */
export function skillSubfolder(files: SkillFiles, subfolder: string | undefined): SkillFiles {
  const prefix = subfolder === undefined ? "" : skillPath(subfolder);
  if (prefix === null) throw new SkillError("The subfolder must be a relative path.");
  const kept: SkillFiles = new Map();
  for (const [path, bytes] of files) {
    const safe = skillPath(path);
    if (safe === null) continue;
    if (prefix === "") kept.set(safe, bytes);
    else if (safe.startsWith(`${prefix}/`)) kept.set(safe.slice(prefix.length + 1), bytes);
  }
  return kept;
}

/** Read a checked-out folder, skipping `.git` and anything that is not a regular file. */
export function readSkillFolder(root: string, limit = SKILL_BUNDLE_LIMIT): SkillFiles {
  const files: SkillFiles = new Map();
  let size = 0;
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === ".git") continue;
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full, `${prefix}${entry}/`);
      else if (stat.isFile()) {
        size += stat.size;
        if (size > limit) throw tooLarge(limit);
        files.set(`${prefix}${entry}`, readFileSync(full));
      }
    }
  };
  walk(root, "");
  return files;
}

/** The `name:` in SKILL.md front matter, when it is a usable skill name. */
export function skillManifestName(files: SkillFiles): string | null {
  const manifest = files.get("SKILL.md");
  if (manifest === undefined) return null;
  const text = new TextDecoder().decode(manifest.subarray(0, 64 * 1024));
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const name = front
    ?.split(/\r?\n/)
    .map((line) => /^name:\s*["']?([^"'#]+?)["']?\s*$/.exec(line)?.[1])
    .find((value) => value !== undefined);
  return name !== undefined && validSkillName(name) ? name : null;
}

/** A content checksum that does not depend on file order or tar metadata. Uploads pin to it. */
export function skillContentHash(files: SkillFiles): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path)!;
    hash.update(`${path}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/**
 * Check the files and write `<root>/<name>/<version>/skill.tar.gz`. A skill needs `SKILL.md`
 * at its top level, and neither its files nor the bundle may exceed `limit`.
 */
export async function writeSkillBundle(
  files: SkillFiles,
  options: { root: string; name: string; version: string; limit?: number },
): Promise<SkillBundle> {
  const limit = options.limit ?? SKILL_BUNDLE_LIMIT;
  if (!files.has("SKILL.md"))
    throw new SkillError("This source has no SKILL.md at the top of the skill folder.");
  let size = 0;
  for (const bytes of files.values()) size += bytes.byteLength;
  if (size > limit) throw tooLarge(limit);
  if (!validSkillName(options.name)) throw new SkillError("That skill name is not allowed.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(options.version))
    throw new SkillError("The resolved version is not a usable folder name.");
  const entries: Record<string, Uint8Array> = {};
  for (const path of [...files.keys()].sort()) entries[path] = files.get(path)!;
  const bytes = await new Bun.Archive(entries, { compress: "gzip" }).bytes();
  if (bytes.byteLength > limit) throw tooLarge(limit);
  const dir = join(options.root, options.name, options.version);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, SKILL_BUNDLE_FILE);
  const partial = `${path}.${process.pid}.partial`;
  try {
    await Bun.write(partial, bytes);
    renameSync(partial, path);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

export function tooLarge(limit: number): SkillError {
  return new SkillError(
    `This skill is over the ${Math.round(limit / (1024 * 1024))} MB bundle limit.`,
    413,
  );
}
