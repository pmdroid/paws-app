import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUNNER_PROBE_BYTES } from "../runner-protocol";

const PROBES = ".agents/probes";

function probeTree(root: string, relative = "", tree = new Map<string, string>()) {
  for (const name of readdirSync(join(root, relative))) {
    const path = relative ? `${relative}/${name}` : name;
    const info = lstatSync(join(root, path), { bigint: true });
    if (path === PROBES) continue;
    if (path !== ".agents" || !info.isDirectory())
      tree.set(
        path,
        info.isDirectory() ? "dir" : `${info.mode}:${info.size}:${info.mtimeNs}:${info.ino}`,
      );
    if (info.isDirectory()) probeTree(root, path, tree);
  }
  return tree;
}

export function probeSnapshot(root: string, path: string) {
  const info = lstatSync(join(root, path), { throwIfNoEntry: false });
  return {
    tree: probeTree(root),
    text: info?.isFile() ? readFileSync(join(root, path), "utf8") : "",
  };
}

export function collectProbe(
  root: string,
  path: string,
  { tree: before, text: previous }: ReturnType<typeof probeSnapshot>,
): { probe?: { path: string; text: string }; error?: string } {
  const after = probeTree(root);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((entry) => before.get(entry) !== after.get(entry))
    .sort();
  if (changed.length)
    return {
      error: `The agent changed files outside ${PROBES}/: ${changed.slice(0, 10).join(", ")}`,
    };
  const file = join(root, path);
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) return { error: `The agent did not write ${path}` };
  if (!info.isFile() || realpathSync(dirname(file)) !== join(realpathSync(root), PROBES))
    return { error: `${path} is not a regular file in ${PROBES}` };
  if (info.size > RUNNER_PROBE_BYTES)
    return { error: `${path} is larger than ${RUNNER_PROBE_BYTES} bytes` };
  const text = readFileSync(file, "utf8");
  if (!text || text === previous) return { error: `The agent left ${path} empty or unchanged` };
  return { probe: { path, text } };
}
