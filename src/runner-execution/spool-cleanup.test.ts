import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setJournalSink } from "../journal";
import { createRunnerSpoolCleaner, removeRunnerJob } from "./spool-cleanup";

const UNKNOWN = "01M5G3S0APA5K5E73V8RFCX9T1";
const HELD = "01M5G3S0APA5K5E73V8RFCX9T2";
const RECENT = "01M5G3S0APA5K5E73V8RFCX9T3";
const NOW = Date.parse("2026-11-24T12:00:00Z");
const HOUR = 3_600_000;
const nonRootLinux = process.platform === "linux" && process.getuid!() > 0 && process.getgid!() > 0;

const roots: string[] = [];
let restoreJournal: (() => void) | undefined;
afterEach(() => {
  restoreJournal?.();
  restoreJournal = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function spoolRoot() {
  const parent = mkdtempSync(join(tmpdir(), "paws-spool-cleanup-"));
  roots.push(parent);
  const root = join(parent, "spool");
  mkdirSync(root, { mode: 0o750 });
  chmodSync(root, 0o750);
  return { root, runnerUid: process.getuid!(), agentGid: process.getgid!() };
}

function job(root: string, name: string, ageHours: number) {
  const path = join(root, name);
  mkdirSync(join(path, "answers"), { recursive: true });
  writeFileSync(join(path, "repository-blobs.pack"), "x".repeat(1000));
  chmodSync(join(path, "answers"), 0o550);
  const at = new Date(NOW - ageHours * HOUR);
  for (const entry of [join(path, "repository-blobs.pack"), join(path, "answers"), path])
    utimesSync(entry, at, at);
  return path;
}

test.skipIf(!nonRootLinux)(
  "the sweep removes only old job directories of executions the runner no longer holds",
  async () => {
    const spool = spoolRoot();
    const lines: string[] = [];
    restoreJournal = setJournalSink((line) => lines.push(line));
    const unknown = job(spool.root, UNKNOWN, 25);
    const held = job(spool.root, HELD, 25);
    const recent = job(spool.root, RECENT, 1);
    const foreign = job(spool.root, "not-an-execution", 25);
    const cleaner = createRunnerSpoolCleaner({
      spool,
      holds: () => new Set([HELD]),
      now: () => NOW,
    });
    await cleaner.sweep();
    expect(existsSync(unknown)).toBe(false);
    expect(existsSync(held)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    const swept = lines.filter((line) => line.includes("runner spool swept"));
    expect(swept).toHaveLength(1);
    expect(swept[0]).toContain("removed=1");
    expect(Number(/bytes=(\d+)/.exec(swept[0]!)![1])).toBeGreaterThanOrEqual(1000);
    await cleaner.sweep();
    expect(lines.filter((line) => line.includes('name="not-an-execution"'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("runner spool swept"))).toHaveLength(2);
  },
);

test.skipIf(!nonRootLinux)("removing a finished job takes its blob pack with it", () => {
  const spool = spoolRoot();
  const path = job(spool.root, UNKNOWN, 0);
  removeRunnerJob(spool, UNKNOWN);
  expect(existsSync(path)).toBe(false);
  removeRunnerJob(spool, UNKNOWN);
  expect(() => removeRunnerJob(spool, "../escape")).toThrow();
});
