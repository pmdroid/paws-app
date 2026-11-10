import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type PackageJson = { packageManager?: unknown; engines?: Record<string, unknown> };

const TOOLS = [
  ["Cargo.toml", "cargo", "rust", "stable"],
  ["go.mod", "go", "go", "latest"],
  ["pyproject.toml", "python3", "python", "3.12"],
  ["Gemfile", "ruby", "ruby", "3.3"],
  ["bun.lock", "bun", "bun", "latest"],
  ["bun.lockb", "bun", "bun", "latest"],
  ["package.json", "node", "node", "lts"],
] as const;

export function missingToolchainQuestion(worktree: string, path: string): string | undefined {
  const directories = [""];
  for (const entry of readdirSync(worktree, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    directories.push(entry.name);
    if (entry.name === "apps" || entry.name === "packages")
      for (const child of readdirSync(join(worktree, entry.name), { withFileTypes: true }))
        if (child.isDirectory()) directories.push(`${entry.name}/${child.name}`);
  }
  const missing = new Map<string, { manifest: string; count: number }>();
  const entries = new Map<string, string>();
  for (const directory of directories.sort()) {
    const root = join(worktree, directory);
    const pkg = existsSync(join(root, "package.json"))
      ? readPackageJson(join(root, "package.json"))
      : undefined;
    for (const [manifest, tool, name, fallback] of TOOLS) {
      if (manifest === "package.json" && pkg && !needsNode(worktree, directory, pkg)) continue;
      if (!existsSync(join(root, manifest)) || Bun.which(tool, { PATH: path, cwd: worktree }))
        continue;
      const found = missing.get(tool);
      if (found) found.count++;
      else
        missing.set(tool, { manifest: `${directory ? `${directory}/` : ""}${manifest}`, count: 1 });
      if (!entries.has(name)) entries.set(name, declaredVersion(pkg, name) ?? fallback);
    }
  }
  if (!missing.size) return;
  const descriptions = [...missing].map(
    ([tool, { manifest, count }]) =>
      `${manifest.slice(0, 1_000)}${count > 1 ? ` (and ${count - 1} other manifests)` : ""} needs ${tool}, which isn't installed on the runner.`,
  );
  const toolVersions =
    existsSync(join(worktree, ".tool-versions")) &&
    !existsSync(join(worktree, "mise.toml")) &&
    !existsSync(join(worktree, ".mise.toml"));
  if (toolVersions)
    return `${descriptions.join("\n")} Add these lines to .tool-versions at the repository root (replace a line that already names the tool). Commit the change to main, then answer to retry:\n\n${[
      ...entries,
    ]
      .map(([name, version]) => `${name} ${version}`)
      .join("\n")}`;
  return `${descriptions.join("\n")} Add these entries to the existing [tools] table in mise.toml at the repository root, or create that table if absent. Commit the configuration to main, then answer to retry (do not add a second [tools] header):\n\n[tools]\n${[
    ...entries,
  ]
    .map(([name, version]) => `${name} = "${version}"`)
    .join("\n")}`;
}

function readPackageJson(file: string): PackageJson {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? (value as PackageJson) : {};
  } catch {
    return {};
  }
}

function needsNode(worktree: string, directory: string, pkg: PackageJson): boolean {
  if (typeof pkg.engines?.node === "string") return true;
  if (typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("bun@")) return false;
  if (typeof pkg.engines?.bun === "string") return false;
  for (let at = directory; ; at = dirname(at)) {
    const root = join(worktree, at === "." ? "" : at);
    if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return false;
    if (at === "" || at === ".") return true;
  }
}

function declaredVersion(pkg: PackageJson | undefined, name: string): string | undefined {
  const range = pkg?.engines?.[name];
  return typeof range === "string" ? lowestSatisfying(range) : undefined;
}

function lowestSatisfying(range: string): string | undefined {
  const candidates = new Set<string>();
  for (const match of range.matchAll(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/g)) {
    const major = Number(match[1]);
    const minor = Number(match[2] ?? 0);
    const patch = Number(match[3] ?? 0);
    candidates.add(`${major}.${minor}.${patch}`);
    candidates.add(`${major}.${minor}.${patch + 1}`);
    candidates.add(`${major}.${minor + 1}.0`);
    candidates.add(`${major + 1}.0.0`);
  }
  return [...candidates]
    .sort((left, right) => Bun.semver.order(left, right))
    .find((version) => Bun.semver.satisfies(version, range));
}
