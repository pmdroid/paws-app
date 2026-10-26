import { journalCaught } from "../journal";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * A path the checkout leaves out: a folder (`docs/archive/`), a file or folder (`CHANGELOG.md`),
 * or a simple glob of `*`, `**` and `?` (`fixtures/large/**`, `*.snap` below any folder). Paths
 * are relative to the repository root. `.git`, `.`, `..` and a glob of wildcards only are refused.
 */
export function validateExclusion(entry: string): void {
  const body = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  const parts = body.split("/");
  if (
    body.length === 0 ||
    entry.includes("\\") ||
    [...entry].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    throw new Error(`checkout exclusion must be a relative path or glob: ${JSON.stringify(entry)}`);
  if (parts.every((part) => /^[*?]+$/.test(part)))
    throw new Error(`checkout exclusion would leave out every file: ${JSON.stringify(entry)}`);
}

/** Whether the entry uses `*` or `?`. Every other character is literal. */
export function isGlobExclusion(entry: string): boolean {
  return /[*?]/.test(entry);
}

/** Non-cone sparse-checkout patterns: everything, then each entry anchored at the root. */
export function exclusionPatterns(entries: readonly string[]): string[] {
  for (const entry of entries) validateExclusion(entry);
  return entries.length
    ? [
        "/*",
        ...entries.map(
          (entry) =>
            `!/${entry.replace(isGlobExclusion(entry) ? /([[\] !#])/g : /([*?[\] !#])/g, "\\$1")}`,
        ),
      ]
    : [];
}

/** `git archive` / `git add` pathspecs that leave the entries out, relative to the top. */
export function exclusionPathspecs(entries: readonly string[]): string[] {
  for (const entry of entries) validateExclusion(entry);
  // A glob pathspec matches whole paths, so a glob that names a folder also needs `/**`.
  return entries.flatMap((entry) => {
    if (!isGlobExclusion(entry)) return [`:(top,exclude,literal)${entry.replace(/\/$/, "")}`];
    const glob = escapeGlob(entry.replace(/\/$/, ""));
    return entry.endsWith("/")
      ? [`:(top,exclude,glob)${glob}/**`]
      : [`:(top,exclude,glob)${glob}`, `:(top,exclude,glob)${glob}/**`];
  });
}

/**
 * Whether a repository path is left out by one of the entries. A folder entry covers everything
 * below it; `*` and `?` stay within one segment and `**` spans any number of them.
 */
export function exclusionMatcher(entries: readonly string[]): (path: string) => boolean {
  const tests = entries.map((entry): ((path: string) => boolean) => {
    const body = entry.replace(/\/$/, "");
    if (!isGlobExclusion(body)) return (path) => path === body || path.startsWith(`${body}/`);
    const glob = new Bun.Glob(escapeGlob(body));
    const folderOnly = entry.endsWith("/");
    return (path) => {
      if (!folderOnly && glob.match(path)) return true;
      for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1))
        if (glob.match(path.slice(0, end))) return true;
      return false;
    };
  });
  return (path) => tests.some((test) => test(path));
}

/** Keep `[`, `]`, `{`, `}` and `!` literal, so only `*`, `**` and `?` match. */
function escapeGlob(entry: string): string {
  return entry.replace(/([[\]{}!])/g, "\\$1");
}

function readSparsePatternsSync(tree: string, env?: NodeJS.ProcessEnv): string[] {
  const enabled = execFileSync(
    "git",
    ["-C", tree, "config", "--bool", "--get", "core.sparseCheckout"],
    {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (enabled.trim() !== "true") return [];
  const path = git(
    tree,
    ["rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"],
    env,
  ).trim();
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

export function checkoutPatternsSync(
  tree: string,
  patterns: readonly string[],
  env?: NodeJS.ProcessEnv,
): void {
  const index = git(
    tree,
    ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    env,
  ).trim();
  const pending = `${index}.paws-checkout-pending`;
  const unpopulated = !existsSync(index) || existsSync(pending);
  if (unpopulated) writeFileSync(pending, "", { mode: 0o600 });
  let current: string[] = [];
  try {
    current = readSparsePatternsSync(tree, env);
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
    journalCaught(error, "worktree-checkout.checkoutPatternsSync.readSparsePatternsSync", null);
  }
  if (patterns.length) {
    if (unpopulated || JSON.stringify(current) !== JSON.stringify(patterns)) {
      git(
        tree,
        ["sparse-checkout", "set", "--no-cone", "--no-sparse-index", "--", ...patterns],
        env,
      );
    }
  } else if (current.length) {
    git(tree, ["sparse-checkout", "disable"], env);
  }
  if (unpopulated) {
    git(tree, ["read-tree", "-mu", "HEAD"], env);
    rmSync(pending);
  }
}

function git(tree: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", tree, ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const exec = promisify(execFile);

async function gitAsync(tree: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return (await exec("git", ["-C", tree, ...args], { encoding: "utf8", env })).stdout;
}

async function readSparsePatterns(tree: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  let enabled: string;
  try {
    enabled = await gitAsync(tree, ["config", "--bool", "--get", "core.sparseCheckout"], env);
  } catch (error) {
    if ((error as { code?: number }).code === 1) {
      journalCaught(error, "worktree-checkout.readSparsePatterns.gitAsync", null);
      return [];
    }
    throw error;
  }
  if (enabled.trim() !== "true") return [];
  const path = (
    await gitAsync(
      tree,
      ["rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"],
      env,
    )
  ).trim();
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

export async function checkoutPatterns(
  tree: string,
  patterns: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const index = (
    await gitAsync(tree, ["rev-parse", "--path-format=absolute", "--git-path", "index"], env)
  ).trim();
  const pending = `${index}.paws-checkout-pending`;
  const unpopulated = !existsSync(index) || existsSync(pending);
  if (unpopulated) writeFileSync(pending, "", { mode: 0o600 });
  const current = await readSparsePatterns(tree, env);
  if (patterns.length) {
    if (unpopulated || JSON.stringify(current) !== JSON.stringify(patterns)) {
      await gitAsync(
        tree,
        ["sparse-checkout", "set", "--no-cone", "--no-sparse-index", "--", ...patterns],
        env,
      );
    }
  } else if (current.length) {
    await gitAsync(tree, ["sparse-checkout", "disable"], env);
  }
  if (unpopulated) {
    await gitAsync(tree, ["read-tree", "-mu", "HEAD"], env);
    rmSync(pending);
  }
}
