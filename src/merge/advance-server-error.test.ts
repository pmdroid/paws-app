import { afterEach, describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import { getWorkItem, listJobs, mergeCallInFlight } from "../db";
import { SquashServerError } from "../github";
import { setJournalSink } from "../journal";
import { mergeHarnessPg, type MergeHarnessPg } from "./advance-harness";
import { tempStore } from "../../test/pglite";

let harness: MergeHarnessPg | undefined;
let restoreJournal = () => {};

afterEach(async () => {
  restoreJournal();
  await harness?.cleanup();
  harness = undefined;
});

async function serverErrors(statuses: number[]) {
  const h = (harness = await mergeHarnessPg(await tempStore()));
  const lines: string[] = [];
  restoreJournal = setJournalSink((line) => lines.push(line));
  const item = await h.addItem("ENG-300");
  const left = [...statuses];
  h.state.mergeDenial = async () => {
    const status = left.shift();
    return status === undefined
      ? null
      : { status, body: { message: "Server Error" }, requestId: `req-${left.length}` };
  };
  const squashLines = () => lines.filter((line) => line.startsWith("merge.squash ENG-300"));
  return { h, item, squashLines };
}

describe("GitHub 5xx on the squash merge", () => {
  test("a 500 then 200 merges on the 30 s retry and journals the 500 once", async () => {
    const { h, item, squashLines } = await serverErrors([500]);
    expect(await h.pass(item.id)).toEqual({ kind: "merged" });
    expect(h.state.sleeps).toEqual([30_000]);
    expect(h.github.merged).toHaveLength(1);
    expect(squashLines()).toHaveLength(1);
    expect(squashLines()[0]).toContain(`#${item.pull} GitHub HTTP 500, request id req-0`);
    expect(squashLines()[0]).toContain('body {"message":"Server Error"}');
    expect(squashLines()[0]).toMatch(/commit_title \d+ chars, commit_message \d+ chars/);
  });

  test("three 500s fall back to the job backoff with the pull request unmerged", async () => {
    const { h, item, squashLines } = await serverErrors([500, 500, 500]);
    await expect(h.pass(item.id)).rejects.toBeInstanceOf(SquashServerError);
    expect(h.state.sleeps).toEqual([30_000, 120_000]);
    expect(squashLines()).toHaveLength(3);
    expect(h.github.merged).toEqual([]);
    expect(await mergeCallInFlight(h.db, item.id)).toBe(false);
    expect((await getWorkItem(h.db, item.id))?.state).toBe("merge_queue");
    expect(await h.pass(item.id)).toEqual({ kind: "merged" });
    expect((await listJobs(h.db)).filter((job) => job.queue === JOB_KIND.reverify)).toEqual([]);
  });
});
