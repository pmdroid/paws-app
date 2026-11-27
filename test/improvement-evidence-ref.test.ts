import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { listImprovementProposals } from "../src/db";
import { deliverImprovements, parseRetroEvidenceRef } from "../src/improvements";
import { setJournalSink } from "../src/journal";
import { createFakeImprovementLinear } from "../src/linear";
import { accept, END, worldPg } from "./improvement-fixtures";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const IDS = ["run:A", "work_item:B", "run:C", "work_item:D"];

test("retro evidence ids with colons reach the inbox, review and Linear delivery", async () => {
  const w = await worldPg({}, IDS);
  open.push(w.close);
  const id = w.retro.a;
  const [stored] = await listImprovementProposals(w.db, id);
  expect(stored!.evidence).toEqual(["retro:r1:run:A", "retro:r1:work_item:B"]);

  const inbox = await w.api("ada", "/api/improvements");
  expect(inbox.body.items.map((item: { id: string }) => item.id)).toContain(id);
  const detail = await w.api("ada", `/api/improvements/${id}`);
  expect(detail.status).toBe(200);
  expect(
    detail.body.evidence.map((e: { ref: string; retroId: string }) => [e.ref, e.retroId]),
  ).toEqual([
    ["retro:r1:run:A", "r1"],
    ["retro:r1:work_item:B", "r1"],
  ]);

  const denied = await w.api("ada", "/api/improvements", undefined, []);
  expect(denied.body.items.map((item: { id: string }) => item.id)).not.toContain(id);
  expect((await w.api("ada", `/api/improvements/${id}`, undefined, [])).status).toBe(404);

  expect((await w.api("ada", `/api/improvements/${id}/decision`, accept())).status).toBe(200);
  const linear = createFakeImprovementLinear();
  await deliverImprovements({
    store: w.db,
    owner: "worker",
    now: () => END + 10_000,
    sourceUrl: (improvementId) => `https://paws.test/dashboard/improvements/${improvementId}`,
    linearFor: async () => linear,
  });
  expect(linear.created).toHaveLength(1);
  expect(linear.created[0]!.description).toContain("`question/run:A`: 1");
  expect(linear.created[0]!.description).toContain("`question/work_item:B`: 1");
});

test("a malformed retro evidence reference is skipped and journaled once", async () => {
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    for (const ref of ["retro:R:run:A", "retro:R:work_item:B"])
      expect(parseRetroEvidenceRef(ref)).toEqual({
        retroId: "R",
        evidenceId: ref.slice("retro:R:".length),
      });
    for (const ref of ["retro:R", "retro::e1", "retro:R:", "review:R:e1", "retro_evidence:R:e1"])
      expect(parseRetroEvidenceRef(ref)).toBeNull();

    const w = await worldPg();
    open.push(w.close);
    await w.db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.improvementProposal)
          .set({ evidence: ["retro:r1:ev-a1", "retro:r1"] })
          .where(eq(q.t.improvementProposal.improvementId, w.retro.a)),
      ),
    );
    lines.length = 0;
    const inbox = await w.api("admin", "/api/improvements");
    await w.api("admin", "/api/improvements");
    expect(inbox.body.items.map((item: { id: string }) => item.id)).not.toContain(w.retro.a);
    expect(lines.filter((line) => line.includes('"retro:r1"'))).toHaveLength(1);
  } finally {
    restore();
  }
});
