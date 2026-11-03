/**
 * Fail a runner release whose version is below a feature's minimum runner version.
 *
 * Usage: bun scripts/check-runner-versions.ts <major.minor.patch>
 *
 * Every constant in src/runner-protocol/versions.ts names the first release that has its
 * feature. A release cut from a commit carries every feature on it, so its tag must be at least
 * each of them; otherwise Paws refuses that feature on the runner it just shipped.
 */
import * as versions from "../src/runner-protocol/versions";

export function versionsAbove(release: string): { name: string; version: string }[] {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(release)?.slice(1).map(Number);
  if (!parts)
    throw new Error(`Release version ${JSON.stringify(release)} is not major.minor.patch.`);
  return Object.entries(versions)
    .filter(([, minimum]) => {
      for (const [index, part] of parts.entries())
        if (part !== minimum[index]) return part < minimum[index]!;
      return false;
    })
    .map(([name, minimum]) => ({ name, version: minimum.join(".") }));
}

type Version = readonly number[];

function parse(value: string): Version | undefined {
  return /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)?.slice(1).map(Number);
}

function compare(left: Version, right: Version): number {
  for (const [index, part] of left.entries())
    if (part !== right[index]) return part - right[index]!;
  return 0;
}

export function latestRelease(tags: readonly string[]): string | undefined {
  return tags
    .filter((tag) => parse(tag) !== undefined)
    .sort((left, right) => compare(parse(right)!, parse(left)!))[0];
}

export function releasedVersions(source: string): Record<string, string> {
  const released: Record<string, string> = {};
  for (const match of source.matchAll(
    /export const (\w+): RunnerVersion = \[(\d+), (\d+), (\d+)\];/g,
  ))
    released[match[1]!] = `${match[2]}.${match[3]}.${match[4]}`;
  return released;
}

export function newSinceRelease(
  latest: string,
  released: Record<string, string>,
  current: Record<string, Version> = versions,
): { name: string; version: string }[] {
  const shipped = parse(latest);
  if (!shipped) throw new Error(`Release tag ${JSON.stringify(latest)} is not vmajor.minor.patch.`);
  return Object.entries(current)
    .map(([name, minimum]) => ({ name, version: minimum.join("."), minimum }))
    .filter(
      ({ name, version, minimum }) => released[name] !== version && compare(minimum, shipped) <= 0,
    )
    .map(({ name, version }) => ({ name, version }));
}

function git(args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (run.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

function checkSinceLatestRelease(): number {
  const tags = git(["ls-remote", "--tags", "origin", "refs/tags/v*"])
    .split("\n")
    .map((line) =>
      line
        .split("\t")[1]
        ?.replace(/^refs\/tags\//, "")
        .replace(/\^\{\}$/, ""),
    )
    .filter((tag): tag is string => Boolean(tag));
  const latest = latestRelease(tags);
  if (!latest) return 0;
  git([
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=1",
    "origin",
    `refs/tags/${latest}:refs/tags/${latest}`,
  ]);
  const released = releasedVersions(git(["show", `${latest}:src/runner-protocol/versions.ts`]));
  const slipped = newSinceRelease(latest, released);
  const next = parse(latest)!
    .map((part, index) => (index === 2 ? part + 1 : part))
    .join(".");
  for (const { name, version } of slipped)
    console.error(
      `${name} names runner ${version}, but ${latest} has shipped without it. Set it to ${next}, the next release.`,
    );
  return slipped.length ? 1 : 0;
}

if (import.meta.main && process.argv[2] === "--since-latest-release") {
  process.exit(checkSinceLatestRelease());
} else if (import.meta.main) {
  const release = process.argv[2] ?? "";
  const above = versionsAbove(release);
  for (const { name, version } of above)
    console.error(`${name} needs runner ${version}, but this release is ${release}.`);
  if (above.length) {
    console.error(
      "Tag a release at least as high as every constant in src/runner-protocol/versions.ts.",
    );
    process.exit(1);
  }
}
