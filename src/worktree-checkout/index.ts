import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export function exclusionPatterns(folders: readonly string[]): string[] {
  for (const folder of folders) {
    if (
      folder.length === 0 ||
      folder.includes("\\") ||
      [...folder].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      folder
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
    )
      throw new Error(
        `checkout exclusion must be a relative folder path: ${JSON.stringify(folder)}`,
      );
  }
  return folders.length
    ? ["/*", ...folders.map((folder) => `!/${folder.replace(/([*?[\] !#])/g, "\\$1")}/`)]
    : [];
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
    if ((error as { code?: number }).code === 1) return [];
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
