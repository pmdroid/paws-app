import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  RunnerInstalledRuntimeSchema,
  RunnerInstalledRuntimesSchema,
  type RunnerInstalledRuntime,
} from "../runner-protocol";

/** The most runtimes a runner remembers and reports; the oldest reports drop off first. */
export const RUNNER_RUNTIME_INVENTORY_LIMIT = 64;

const StoredSchema = z.array(
  z.strictObject({ ...RunnerInstalledRuntimeSchema.shape, at: z.number().int().nonnegative() }),
);
type Stored = z.infer<typeof StoredSchema>[number];

/**
 * What mise installed on this runner, as each task's worker reported it. mise keeps one shared
 * install per version, so a version stays installed for every later task. A later report of the
 * same version replaces the earlier one, so a retried install that succeeds clears its error.
 */
export function openRunnerRuntimeInventory(options: {
  root: string;
  now?: () => number;
  onError?: (error: Error) => void;
}) {
  const now = options.now ?? Date.now;
  const path = join(options.root, "runtimes.json");
  const entries = new Map<string, Stored>();
  try {
    for (const entry of StoredSchema.parse(JSON.parse(readFileSync(path, "utf8"))))
      entries.set(key(entry), entry);
  } catch (error) {
    journalCaught(
      error,
      "runtimes.openRunnerRuntimeInventory.parse",
      null,
      "optional file may be absent",
    );
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      options.onError?.(new Error("Runner runtime inventory was unreadable and starts empty."));
  }
  function save() {
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    const partial = `${path}.${randomUUID()}.partial`;
    writeFileSync(partial, JSON.stringify([...entries.values()]), { mode: 0o600 });
    renameSync(partial, path);
  }
  return {
    /** Record a worker's `runtimes.json`. Throws when the report is malformed. */
    record(report: unknown): void {
      const at = now();
      for (const runtime of RunnerInstalledRuntimesSchema.parse(report)) {
        entries.delete(key(runtime));
        entries.set(key(runtime), { ...runtime, at });
      }
      const excess = entries.size - RUNNER_RUNTIME_INVENTORY_LIMIT;
      if (excess > 0)
        for (const stale of [...entries.keys()].slice(0, excess)) entries.delete(stale);
      save();
    },
    /** What the heartbeat reports, sorted by tool and version. */
    installed(): RunnerInstalledRuntime[] {
      return [...entries.values()]
        .map(({ at: _, ...runtime }) => runtime)
        .sort((a, b) => a.tool.localeCompare(b.tool) || a.version.localeCompare(b.version));
    },
  };
}

export type RunnerRuntimeInventory = ReturnType<typeof openRunnerRuntimeInventory>;

function key(runtime: { tool: string; version: string }): string {
  return `${runtime.tool}@${runtime.version}`;
}
