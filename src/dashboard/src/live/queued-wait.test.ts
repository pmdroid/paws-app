import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  insertQueuedItem,
  itemWaitSince,
  recordConfirmedRemoteMerge,
  saveQueuePositions,
  saveTaskBlocks,
  type Db,
} from "../../../db";
import { seed } from "../../../../test/pglite-fixtures";
import { tempStore } from "../../../../test/pglite";
import { waitReason } from "../client/format";
import { createLiveStatusProvider } from "./provider";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function agentbox(): Promise<Db> {
  const store = await tempStore();
  open.push(store.close);
  const db = store.db;
  const states = { "PAS-2316": "running", "PAS-2338": "verifying", "PAS-2339": "merged" } as const;
  for (const [id, state] of Object.entries(states)) {
    await insertQueuedItem(db, { id, now: 10 });
    await seed(db, (q) => q.orm.update(q.t.workItem).set({ state }).where(eq(q.t.workItem.id, id)));
  }
  await recordConfirmedRemoteMerge(db, {
    itemId: "PAS-2339",
    repositoryOwner: "pmdroid",
    repositoryName: "paws-app",
    pullNumber: 2408,
    pullUrl: null,
    mergeSha: "fb349eb21",
    confirmedAt: 20,
  });
  for (const id of ["PAS-2317", "PAS-2340", "PAS-2341", "PAS-2343"]) {
    const item = await insertQueuedItem(db, { id, now: 30 });
    await itemWaitSince(db, item.id, item.version, 30);
  }
  const edges = [
    ["PAS-2316", "PAS-2317"],
    ["PAS-2338", "PAS-2340"],
    ["PAS-2339", "PAS-2340"],
    ["PAS-2338", "PAS-2341"],
    ["PAS-2339", "PAS-2341"],
  ].map(([blocker, blocked]) => ({
    blockerLinearIssueId: `lin-item-${blocker}`,
    blockedLinearIssueId: `lin-item-${blocked}`,
  }));
  await saveTaskBlocks(
    db,
    ["PAS-2317", "PAS-2340", "PAS-2341"].map((id) => `lin-item-${id}`),
    edges,
  );
  return db;
}

async function reasons(db: Db): Promise<Record<string, string | null>> {
  const provider = createLiveStatusProvider(db, { now: () => new Date(40) });
  const list = (await provider.issues()).issues;
  const overview = (await provider.overview()).issues;
  const out: Record<string, string | null> = {};
  for (const item of list) out[item.id] = waitReason(item);
  for (const item of overview) expect(waitReason(item)).toBe(out[item.id]!);
  return out;
}

test("a queued item blocked by a running or verifying issue shows its blockers", async () => {
  const db = await agentbox();
  const shown = await reasons(db);
  expect(shown["PAS-2317"]).toBe("Blocked by PAS-2316");
  expect(shown["PAS-2340"]).toBe("Blocked by PAS-2338");
  expect(shown["PAS-2341"]).toBe("Blocked by PAS-2338");
});

test("a queued item says busy runners only when its queue position waits for slots", async () => {
  const db = await agentbox();
  expect((await reasons(db))["PAS-2343"]).toBe("Waiting to start");
  await saveQueuePositions(
    db,
    ["PAS-2343"],
    { busy: 8, total: 8 },
    40,
    new Map(),
    new Map([["PAS-2343", { kind: "slots", text: "Every runner slot is busy." }]]),
  );
  expect((await reasons(db))["PAS-2343"]).toBe("Waiting for a free runner");
  await saveQueuePositions(db, ["PAS-2343"], { busy: 2, total: 8 }, 40);
  expect((await reasons(db))["PAS-2343"]).toBe("Waiting to start");
});
