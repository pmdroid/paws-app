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

if (import.meta.main) {
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
