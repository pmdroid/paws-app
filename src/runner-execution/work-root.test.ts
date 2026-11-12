import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setJournalSink } from "../journal";
import {
  createRunnerWorkCleaner,
  openRunnerCheckoutToGroup,
  openRunnerRunStatesToGroup,
} from "./work-root";

const RUN = "2a9fbb49-c286-44d3-83dc-32dffc766b31";
const OTHER_RUN = "0087b90c-d150-4694-a84a-c9642805aa4e";
const EXECUTION = "01M5G3S0APA5K5E73V8RFCX9T1";
const NOW = Date.parse("2026-11-09T12:00:00Z");
const HOUR = 3_600_000;

const roots: string[] = [];
let restoreJournal: (() => void) | undefined;
afterEach(() => {
  restoreJournal?.();
  restoreJournal = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(held: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "paws-work-root-"));
  roots.push(root);
  const lines: string[] = [];
  restoreJournal = setJournalSink((line) => lines.push(line));
  const holds = new Set(held);
  return {
    root,
    lines,
    holds,
    cleaner: createRunnerWorkCleaner({ workRoot: root, holds: () => holds, now: () => NOW }),
  };
}

function checkout(root: string, name: string, ageHours: number) {
  const path = join(root, name);
  mkdirSync(join(path, "src"), { recursive: true });
  writeFileSync(join(path, "src", "a.ts"), "12345");
  const at = new Date(NOW - ageHours * HOUR);
  for (const entry of [join(path, "src", "a.ts"), join(path, "src"), path])
    utimesSync(entry, at, at);
  return path;
}

test("a finished run's checkout is deleted and journalled with its size", async () => {
  const { root, cleaner, lines } = fixture();
  const path = checkout(root, RUN, 1);
  await cleaner.released([RUN]);
  expect(existsSync(path)).toBe(false);
  const line = lines.find((text) => text.includes(`name=${RUN}`))!;
  expect(line).toContain("reason=finished");
  expect(Number(/bytes=(\d+)/.exec(line)![1])).toBeGreaterThanOrEqual(5);
});

test("a checkout Paws has not named, as for a run waiting on a question, is kept", async () => {
  const { root, cleaner } = fixture();
  const waiting = checkout(root, OTHER_RUN, 1);
  const finished = checkout(root, RUN, 1);
  await cleaner.released([RUN]);
  await cleaner.sweep();
  expect(existsSync(finished)).toBe(false);
  expect(existsSync(waiting)).toBe(true);
});

test("a finished run a live execution still uses is kept, then deleted when Paws repeats it", async () => {
  const { root, cleaner, holds } = fixture([RUN]);
  const path = checkout(root, RUN, 1);
  await cleaner.released([RUN]);
  expect(existsSync(path)).toBe(true);
  holds.clear();
  await cleaner.released([RUN]);
  expect(existsSync(path)).toBe(false);
});

test("the sweep deletes idle checkouts and orphaned execution folders, not what is in use", async () => {
  const { root, cleaner, lines } = fixture([OTHER_RUN]);
  const idle = checkout(root, RUN, 25);
  const held = checkout(root, OTHER_RUN, 25);
  const recent = checkout(root, "c78a93e9-57f2-4b9d-bd03-ad7ad23335be", 23);
  const orphan = join(root, EXECUTION);
  mkdirSync(orphan);
  await cleaner.sweep();
  expect(existsSync(idle)).toBe(false);
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(held)).toBe(true);
  expect(existsSync(recent)).toBe(true);
  expect(lines.at(-1)).toContain("removed=2");
});

test("a run checkout touched deep inside counts as touched", async () => {
  const { root, cleaner } = fixture();
  const path = checkout(root, RUN, 25);
  const at = new Date(NOW - HOUR);
  utimesSync(join(path, "src", "a.ts"), at, at);
  await cleaner.sweep();
  expect(existsSync(path)).toBe(true);
});

test("the sweep leaves .paws entries and everything else it does not recognize", async () => {
  const { root, cleaner } = fixture();
  const names = [".paws", ".paws-skills-1", ".gh-2a9fbb49", "shots-707"];
  for (const name of names) checkout(root, name, 100);
  writeFileSync(join(root, EXECUTION), "a file, not a folder");
  await cleaner.sweep();
  await cleaner.released([".paws", ".paws-skills-1", "../outside"]);
  expect(readdirSync(root).sort()).toEqual([EXECUTION, ...names].sort());
});

test("a symbolic link in place of a folder is left, and its target is not followed", async () => {
  const { root, cleaner } = fixture();
  const target = checkout(root, "keep", 100);
  symlinkSync(target, join(root, EXECUTION));
  await cleaner.sweep();
  expect(existsSync(join(target, "src", "a.ts"))).toBe(true);
});

test("a folder the runner does not own is emptied through its group bits, without chmod", async () => {
  const { root, cleaner } = fixture();
  const path = checkout(root, RUN, 1);
  const uid = spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
  try {
    await cleaner.released([RUN]);
  } finally {
    uid.mockRestore();
  }
  expect(existsSync(path)).toBe(false);
});

test("a folder that cannot be deleted is reported once, and the rest still go", async () => {
  const { root, cleaner, lines } = fixture();
  const stuck = checkout(root, RUN, 25);
  const next = checkout(root, OTHER_RUN, 25);
  chmodSync(join(stuck, "src"), 0o500);
  const uid = spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
  try {
    await cleaner.released([RUN]);
    const attempts = lines.length;
    await cleaner.released([RUN]);
    expect(lines.length).toBe(attempts);
    await cleaner.sweep();
  } finally {
    uid.mockRestore();
    chmodSync(join(stuck, "src"), 0o700);
  }
  expect(existsSync(stuck)).toBe(true);
  expect(existsSync(next)).toBe(false);
  expect(lines.at(-1)).toContain("failed=1");
});

function runState(root: string, name: string, ageHours: number) {
  mkdirSync(join(root, ".paws", "runs"), { recursive: true });
  return checkout(join(root, ".paws", "runs"), name, ageHours);
}

test("the sweep removes run state idle for over three days, unless its execution is held", async () => {
  const { root, cleaner, lines } = fixture([OTHER_RUN, EXECUTION]);
  const finished = runState(root, "01M5G3S6DC4RPESGCXGNMK9ZCY", 4 * 24);
  const recent = runState(root, "01M5G3S8FR2T339ZX2RTA5K2MZ", 24);
  const active = runState(root, EXECUTION, 30 * 24);
  const helper = runState(root, OTHER_RUN, 30 * 24);
  await cleaner.sweep();
  expect(existsSync(finished)).toBe(false);
  expect([recent, active, helper].map((path) => existsSync(path))).toEqual([true, true, true]);
  expect(lines).toContainEqual(
    expect.stringContaining("removed name=.paws/runs/01M5G3S6DC4RPESGCXGNMK9ZCY reason=sweep"),
  );
});

test("the sweep does not follow .paws or .paws/runs when either is a symbolic link", async () => {
  const { root, cleaner } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "paws-outside-"));
  roots.push(outside);
  const kept = checkout(outside, EXECUTION, 30 * 24);
  mkdirSync(join(root, ".paws"));
  symlinkSync(outside, join(root, ".paws", "runs"));
  await cleaner.sweep();
  rmSync(join(root, ".paws"), { recursive: true });
  symlinkSync(join(outside, ".."), join(root, ".paws"));
  mkdirSync(join(outside, "..", "runs"), { recursive: true });
  await cleaner.sweep();
  expect(existsSync(kept)).toBe(true);
});

test("a run state folder that cannot be removed is tried again only once its access changes", async () => {
  const { root, cleaner, lines } = fixture();
  const stuck = runState(root, EXECUTION, 30 * 24);
  chmodSync(join(stuck, "src"), 0o500);
  const uid = spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
  try {
    await cleaner.sweep();
    expect(lines.at(-1)).toContain("failed=1");
    await cleaner.sweep();
    expect(lines.at(-1)).toContain("failed=0");
  } finally {
    uid.mockRestore();
    chmodSync(join(stuck, "src"), 0o700);
  }
  chmodSync(stuck, 0o770);
  await cleaner.sweep();
  expect(existsSync(stuck)).toBe(false);
});

test("a worker opens the private run state folders it owns to the group, not other entries", () => {
  const { root } = fixture();
  const own = runState(root, EXECUTION, 30 * 24);
  const other = runState(root, "not-a-run", 30 * 24);
  for (const path of [join(own, "src"), own, other]) chmodSync(path, 0o700);
  openRunnerRunStatesToGroup(root);
  const mode = (path: string) => statSync(path).mode & 0o777;
  expect([mode(own), mode(join(own, "src")), mode(other)]).toEqual([0o770, 0o770, 0o700]);
});

test("one sweep removes at most 5,000 run state folders, and the next removes the rest", async () => {
  const { root, cleaner } = fixture();
  const runs = join(root, ".paws", "runs");
  mkdirSync(runs, { recursive: true });
  const at = new Date(NOW - 4 * 24 * HOUR);
  for (let index = 0; index < 5_003; index++) {
    const path = join(runs, `01M5G3S6DC4RPESGCXG${index.toString().padStart(7, "0")}`);
    mkdirSync(path);
    utimesSync(path, at, at);
  }
  await cleaner.sweep();
  expect(readdirSync(runs)).toHaveLength(3);
  await cleaner.sweep();
  expect(readdirSync(runs)).toHaveLength(0);
});

function largeCheckout(root: string, name: string) {
  const path = checkout(root, name, 1);
  for (let index = 0; index < 5_000; index++) writeFileSync(join(path, "src", `${index}.ts`), "");
  return path;
}

test("a large checkout leaves the event loop running while it is deleted", async () => {
  const { root, cleaner } = fixture();
  const path = largeCheckout(root, RUN);
  let ticks = 0;
  const ticking = setInterval(() => ticks++, 0);
  await cleaner.released([RUN]);
  clearInterval(ticking);
  expect(existsSync(path)).toBe(false);
  expect(ticks).toBeGreaterThan(3);
});

test("work admitted while a checkout is measured or deleted stops the deletion", async () => {
  const { root, cleaner, holds, lines } = fixture();
  const path = largeCheckout(root, RUN);
  const admitted = (async () => {
    for (let tick = 0; tick < 3; tick++) await new Promise((resolve) => setImmediate(resolve));
    holds.add(RUN);
  })();
  await cleaner.released([RUN]);
  await admitted;
  expect(existsSync(path)).toBe(true);
  expect(lines.some((line) => line.includes(`removed name=${RUN}`))).toBe(false);
});

test("a worker opens folders it owns to the group and keeps their other bits", () => {
  const { root } = fixture();
  const path = checkout(root, RUN, 1);
  mkdirSync(join(path, "node_modules", "pkg"), { recursive: true });
  chmodSync(join(path, "node_modules", "pkg"), 0o750);
  chmodSync(join(path, "node_modules"), 0o700);
  chmodSync(join(path, "src", "a.ts"), 0o600);
  const before = statSync(join(path, "src", "a.ts")).mtimeMs;
  openRunnerCheckoutToGroup(path);
  const mode = (entry: string) => statSync(join(path, entry)).mode & 0o777;
  expect([mode("node_modules"), mode("node_modules/pkg")]).toEqual([0o770, 0o770]);
  expect(mode("src/a.ts")).toBe(0o600);
  expect(statSync(join(path, "src", "a.ts")).mtimeMs).toBe(before);
});
