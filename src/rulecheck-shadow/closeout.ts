import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ShadowSide } from "./compare";
import { parseRulecheckReceipt } from "./receipt";

const record = z.looseObject({
  recordType: z.literal("command"),
  itemId: z.string(),
  head: z.string(),
  attempt: z.number().int(),
  exec: z.looseObject({
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    headMoved: z.boolean(),
    truncated: z.boolean(),
  }),
  artifacts: z.array(z.looseObject({ path: z.string() })),
  ci: z.unknown().optional(),
  carried: z.looseObject({ head: z.string() }).optional(),
});

type CommandRecord = z.infer<typeof record>;

const EXIT = { pass: 0, violation: 1, error: 2 } as const;

export function readCloseoutReceipt(input: {
  evidenceDir: string;
  itemId: string;
  head: string;
}): ShadowSide {
  const source = `Closeout ${input.itemId} at ${input.head}`;
  const found = latestRecord(input);
  if (found === null)
    return {
      receipt: null,
      source,
      reason: `Closeout has no ${input.itemId} record at this head.`,
    };
  const { path, value } = found;
  const where = `${source} (${path})`;
  if (value.ci !== undefined)
    return {
      receipt: null,
      source: where,
      reason:
        "Closeout took this result from CI instead of running Rulecheck, so it is not an independent receipt. Remove `ci:` from the item.",
    };
  if (value.carried !== undefined)
    return {
      receipt: null,
      source: where,
      reason: `Closeout carried this result from ${value.carried.head}; the new head needs its own run.`,
    };
  const log = value.artifacts[0];
  if (log === undefined) return { receipt: null, source: where, reason: "the record has no log." };
  const logPath = join(input.evidenceDir, ...log.path.split("/"));
  if (!existsSync(logPath))
    return { receipt: null, source: where, reason: `the log ${log.path} is missing.` };
  const text = readFileSync(logPath, "utf8");
  const parsed = parseRulecheckReceipt(stdoutOf(text));
  if (!parsed.ok) return { receipt: null, source: where, reason: parsed.reason };
  const gaps: string[] = [];
  if (value.exec.timedOut) gaps.push("the Closeout command timed out.");
  if (value.exec.truncated) gaps.push("the Closeout command's output was truncated.");
  if (value.exec.headMoved) gaps.push("the head moved while the Closeout command ran.");
  const exitCode = shadowExit(text) ?? value.exec.exitCode;
  if (exitCode !== EXIT[parsed.receipt.outcome])
    gaps.push(
      `Rulecheck exited ${exitCode ?? "without a code"}, but the receipt's outcome is ${parsed.receipt.outcome}.`,
    );
  return { receipt: parsed.receipt, source: where, gaps };
}

function shadowExit(log: string): number | null {
  const stderr = log.slice(log.indexOf("\nSTDERR\n") + 1);
  const match = /^rulecheck-exit=(\d+)$/m.exec(stderr);
  return match ? Number(match[1]) : null;
}

function stdoutOf(log: string): string {
  const body = log.startsWith("STDOUT\n") ? log.slice("STDOUT\n".length) : log;
  const end = body.indexOf("\nSTDERR\n");
  return end === -1 ? body : body.slice(0, end);
}

function latestRecord(input: {
  evidenceDir: string;
  itemId: string;
  head: string;
}): { path: string; value: CommandRecord } | null {
  const root = join(input.evidenceDir, "evidence");
  if (!existsSync(root)) return null;
  let best: { path: string; value: CommandRecord; at: number } | null = null;
  for (const digest of readdirSync(root)) {
    const folder = join(root, digest, input.head, ...input.itemId.split("/"));
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder)) {
      if (!/^\d+\.json$/.test(file)) continue;
      const path = join(folder, file);
      const parsed = record.safeParse(safeJson(readFileSync(path, "utf8")));
      if (!parsed.success) continue;
      const value = parsed.data;
      if (value.itemId !== input.itemId || value.head !== input.head) continue;
      const at = statSync(path).mtimeMs;
      if (best === null || at > best.at || (at === best.at && value.attempt > best.value.attempt))
        best = { path, value, at };
    }
  }
  return best;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
