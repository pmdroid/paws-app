import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;

/**
 * What the runner package runs from `app/src`: the commands behind `paws-runner runner …`, and
 * the scripts the runner starts with Bun by path (`ask-team-mcp.ts`, `process-anchor.ts`).
 */
const RUNNER_ENTRIES = [
  "src/runner-cli/index.ts",
  "src/runner-daemon/index.ts",
  "src/runner-worker/index.ts",
  "src/runner-execution/index.ts",
  "src/acp/ask-team-mcp.ts",
  "src/process/process-anchor.ts",
];

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveRelative(from: string, specifier: string) {
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  const found = candidates.find(isFile);
  if (!found) throw new Error(`${from} imports ${specifier}, which does not resolve`);
  return found;
}

/** Follows every relative runtime import (static, re-export and dynamic) from `entries` and returns the import chain to each file under `forbidden`. */
function chainsInto(root: string, entries: readonly string[], forbidden: string) {
  const fence = resolve(root, forbidden) + "/";
  const parent = new Map<string, string | null>();
  const queue = entries.map((entry) => resolve(root, entry));
  for (const entry of queue) parent.set(entry, null);
  const reached: string[][] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (file.startsWith(fence)) {
      const chain: string[] = [];
      for (let at: string | null = file; at; at = parent.get(at)!)
        chain.unshift(relative(root, at));
      reached.push(chain);
      continue;
    }
    if (!/\.tsx?$/.test(file)) continue;
    const transpiler = file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (!path.startsWith(".")) continue;
      const next = resolveRelative(file, path);
      if (parent.has(next)) continue;
      parent.set(next, file);
      queue.push(next);
    }
  }
  return { reached, files: parent.size };
}

test("no runner entry point reaches the dashboard in src/web", () => {
  const { reached, files } = chainsInto(ROOT, RUNNER_ENTRIES, "src/web");
  expect(files).toBeGreaterThan(RUNNER_ENTRIES.length);
  expect(reached.map((chain) => chain.join(" -> "))).toEqual([]);
});

test("the check names the chain when a runner module imports src/web, directly or through another module", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-imports-"));
  const write = (name: string, content: string) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  };
  try {
    write("src/runner-cli/index.ts", 'export { daemon } from "../runner-daemon";\n');
    write("src/runner-daemon/index.ts", 'import "./work";\nexport const daemon = 1;\n');
    write(
      "src/runner-daemon/work.ts",
      'const page = await import("../status");\nexport { page };\n',
    );
    write("src/status/index.ts", 'export * from "../web";\n');
    write(
      "src/runner-worker/index.ts",
      'import { STATUS } from "../web/contract";\nexport { STATUS };\n',
    );
    write("src/runner-worker/types.ts", 'import type { StatusSnapshot } from "../web/contract";\n');
    write("src/web/index.ts", "export const page = 1;\n");
    write(
      "src/web/contract.ts",
      'export type StatusSnapshot = object;\nexport const STATUS = "/status";\n',
    );
    write("src/webhooks/index.ts", "export const hook = 1;\n");
    write("src/runner-execution/index.ts", 'export * from "../webhooks";\n');

    // A type-only import is erased before Bun runs the file, so it loads nothing from src/web.
    expect(
      chainsInto(root, ["src/runner-execution/index.ts", "src/runner-worker/types.ts"], "src/web")
        .reached,
    ).toEqual([]);
    expect(
      chainsInto(root, ["src/runner-cli/index.ts", "src/runner-worker/index.ts"], "src/web")
        .reached,
    ).toEqual([
      ["src/runner-worker/index.ts", "src/web/contract.ts"],
      [
        "src/runner-cli/index.ts",
        "src/runner-daemon/index.ts",
        "src/runner-daemon/work.ts",
        "src/status/index.ts",
        "src/web/index.ts",
      ],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
