/**
 * Check `MINIMUM_RUNNER_VERSION` against runner releases.
 *
 * Usage: bun scripts/check-runner-versions.ts <major.minor.patch>
 *        bun scripts/check-runner-versions.ts --since-latest-release
 *
 * A release must be at least the minimum, or Paws refuses the runner it just shipped. Between
 * releases the minimum must name a runner that has shipped, and must not drop below the minimum
 * the latest release carried.
 */
import { MINIMUM_RUNNER_VERSION } from "../src/runner-protocol/versions";

type Version = readonly number[];

function parse(value: string): Version | undefined {
  return /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)?.slice(1).map(Number);
}

function compare(left: Version, right: Version): number {
  for (const [index, part] of left.entries())
    if (part !== right[index]) return part - right[index]!;
  return 0;
}

export function releaseBelowMinimum(
  release: string,
  minimum: Version = MINIMUM_RUNNER_VERSION,
): boolean {
  const parsed = release.startsWith("v") ? undefined : parse(release);
  if (!parsed)
    throw new Error(`Release version ${JSON.stringify(release)} is not major.minor.patch.`);
  return compare(parsed, minimum) < 0;
}

export function latestRelease(tags: readonly string[]): string | undefined {
  return tags
    .filter((tag) => parse(tag) !== undefined)
    .sort((left, right) => compare(parse(right)!, parse(left)!))[0];
}

export function releasedMinimum(source: string): Version | undefined {
  const match =
    /export const MINIMUM_RUNNER_VERSION: RunnerVersion = \[(\d+), (\d+), (\d+)\];/.exec(source);
  return match?.slice(1).map(Number);
}

export function minimumAboveRelease(
  latest: string,
  minimum: Version = MINIMUM_RUNNER_VERSION,
): boolean {
  const shipped = latest.startsWith("v") ? parse(latest) : undefined;
  if (!shipped) throw new Error(`Release tag ${JSON.stringify(latest)} is not vmajor.minor.patch.`);
  return compare(minimum, shipped) > 0;
}

export function minimumLowered(
  released: Version | undefined,
  minimum: Version = MINIMUM_RUNNER_VERSION,
): boolean {
  return released !== undefined && compare(minimum, released) < 0;
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
  const released = releasedMinimum(git(["show", `${latest}:src/runner-protocol/versions.ts`]));
  const minimum = MINIMUM_RUNNER_VERSION.join(".");
  const unreleased = minimumAboveRelease(latest);
  if (unreleased)
    console.error(
      `MINIMUM_RUNNER_VERSION names runner ${minimum}, above ${latest}, so every runner would be outdated. Set it to a released version.`,
    );
  const lowered = minimumLowered(released);
  if (lowered)
    console.error(
      `MINIMUM_RUNNER_VERSION names runner ${minimum}, below ${released!.join(".")} in ${latest}. Do not lower it.`,
    );
  return unreleased || lowered ? 1 : 0;
}

if (import.meta.main && process.argv[2] === "--since-latest-release") {
  process.exit(checkSinceLatestRelease());
} else if (import.meta.main) {
  const release = process.argv[2] ?? "";
  if (releaseBelowMinimum(release)) {
    console.error(
      `MINIMUM_RUNNER_VERSION needs runner ${MINIMUM_RUNNER_VERSION.join(".")}, but this release is ${release}. Tag a release at least that high.`,
    );
    process.exit(1);
  }
}
