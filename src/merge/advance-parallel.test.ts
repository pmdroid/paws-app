import { afterEach, describe, expect, test } from "bun:test";
import { readSetting } from "../db";
import { setJournalSink } from "../journal";
import { failingTest, mergeHarnessPg, pendingCi, type MergeHarnessPg } from "./advance-harness";
import { saveChangedPaths } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

let harness: MergeHarnessPg | undefined;
let restoreJournal: (() => void) | undefined;
let journalLines: string[] = [];

afterEach(async () => {
  restoreJournal?.();
  await harness?.cleanup();
  harness = undefined;
});

async function start(parallel: number) {
  harness = await mergeHarnessPg(await tempStore(), {
    settings: { order: "queue", mainMoved: "green" },
  });
  harness.state.parallel = parallel;
  journalLines = [];
  restoreJournal = setJournalSink((line) => journalLines.push(line));
  return harness;
}

async function lane(h: MergeHarnessPg, files: Record<string, string[]>) {
  h.state.ci = pendingCi;
  for (const [id, paths] of Object.entries(files)) {
    const item = await h.addItem(id);
    await saveChangedPaths(h.db, {
      itemId: id,
      head: item.accepted,
      paths,
      recordedAt: h.clock.now(),
    });
    expect(await h.pass(id)).toMatchObject({ kind: "wait" });
    h.clock.advance(1_000);
  }
  h.state.ci = () => undefined;
}

function merged(h: MergeHarnessPg): number[] {
  return h.github.merged.map((merge) => merge.number);
}

const greenMain = () => [{ name: "ci", conclusion: "SUCCESS", detailsUrl: null }];

describe("[merge] parallel", () => {
  test("two green pull requests with disjoint files in one lane merge at once", async () => {
    const h = await start(3);
    await lane(h, { "ENG-1": ["a.ts"], "ENG-2": ["b.ts"] });
    expect(await h.pass("ENG-2")).toEqual({ kind: "merged" });
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(merged(h)).toEqual([2, 1]);
  });

  test("two pull requests that share a file merge one after another", async () => {
    const h = await start(3);
    await lane(h, { "ENG-1": ["a.ts", "shared.ts"], "ENG-2": ["shared.ts"] });
    expect(await h.pass("ENG-2")).toMatchObject({ kind: "wait", reason: "ahead" });
    expect(merged(h)).toEqual([]);
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(await h.pass("ENG-2")).toEqual({ kind: "merged" });
    expect(merged(h)).toEqual([1, 2]);
  });

  test("with parallel = 1 the second task waits for the head of the lane", async () => {
    const h = await start(1);
    await lane(h, { "ENG-1": ["a.ts"], "ENG-2": ["b.ts"] });
    const reads = h.state.ciReads.length;
    expect(await h.pass("ENG-2")).toMatchObject({ kind: "wait", reason: "ahead" });
    expect(h.state.ciReads.length).toBe(reads);
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(await h.pass("ENG-2")).toEqual({ kind: "merged" });
    expect(merged(h)).toEqual([1, 2]);
    expect(await readSetting(h.db, 'merge.batch:["acme/app",""]')).toBeNull();
  });

  test("a red main after a batch keeps the lane at one at a time until main is green", async () => {
    const h = await start(3);
    await lane(h, { "ENG-1": ["a.ts"], "ENG-2": ["b.ts"] });
    expect(await h.pass("ENG-2")).toEqual({ kind: "merged" });
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    await lane(h, { "ENG-3": ["c.ts"], "ENG-4": ["d.ts"] });

    h.state.baseCi = failingTest;
    expect(await h.pass("ENG-4")).toMatchObject({ kind: "wait", reason: "ahead" });
    expect(await h.pass("ENG-4")).toMatchObject({ kind: "wait", reason: "ahead" });
    expect(journalLines.filter((line) => line.includes("#2, #1"))).toEqual([
      "Main's CI failed after the acme/app merge lane merged #2, #1 together; the lane merges one at a time until main is green.",
    ]);

    h.state.baseCi = greenMain;
    expect(await h.pass("ENG-4")).toEqual({ kind: "merged" });
    expect(merged(h)).toEqual([2, 1, 4]);
  });
});
