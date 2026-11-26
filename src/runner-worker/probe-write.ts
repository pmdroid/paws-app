import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNER_PROBE_BYTES } from "../runner-protocol";

const PROBES = ".agents/probes";

export function probeTree(root: string, relative = "", tree = new Map<string, string>()) {
  for (const name of readdirSync(join(root, relative))) {
    const path = relative ? `${relative}/${name}` : name;
    if (path === PROBES) continue;
    const info = lstatSync(join(root, path), { bigint: true });
    if (!info.isDirectory())
      tree.set(path, `${info.mode}:${info.size}:${info.mtimeNs}:${info.ino}`);
    else {
      if (path !== ".agents") tree.set(path, "dir");
      probeTree(root, path, tree);
    }
  }
  return tree;
}

export function collectProbe(
  root: string,
  path: string,
  before: Map<string, string>,
): { probe?: { path: string; text: string }; error?: string } {
  const after = probeTree(root);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((entry) => before.get(entry) !== after.get(entry))
    .sort();
  if (changed.length)
    return {
      error: `The agent changed files outside ${PROBES}/: ${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ", …" : ""}`,
    };
  const parts = path.split("/");
  for (let depth = 1; depth <= parts.length; depth++) {
    const part = parts.slice(0, depth).join("/");
    let info;
    try {
      info = lstatSync(join(root, part));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    if (depth < parts.length ? !info.isDirectory() : !info.isFile())
      return { error: `${part} is not a regular ${depth < parts.length ? "directory" : "file"}` };
    if (depth === parts.length && info.size > RUNNER_PROBE_BYTES)
      return { error: `${path} is larger than ${RUNNER_PROBE_BYTES} bytes` };
  }
  const text = readFileSync(join(root, path), "utf8");
  return text ? { probe: { path, text } } : {};
}
