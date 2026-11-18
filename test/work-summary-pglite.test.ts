import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentSourceContextRecords, type Db } from "../src/db";
import { recordPullRequestSummary } from "../src/loop";
import {
  createFakeContextAccess,
  createFakeProjectContextReads,
  createProjectSessionContext,
  ingestLinearProjectContext,
} from "../src/project-context";
import { tempStore } from "./pglite";

const T0 = Date.parse("2026-11-18T12:00:00Z");

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await tempStore());
});
afterAll(async () => {
  await close();
});

async function fixture(workSummary = true) {
  seq++;
  const pawsRoot = mkdtempSync(join(tmpdir(), "paws-work-summary-"));
  writeFileSync(join(pawsRoot, "config.toml"), `[project_memory]\nwork_summary = ${workSummary}\n`);
  const [organizationId, projectId, requesterId] = [`org-${seq}`, `project-${seq}`, `alice-${seq}`];
  const scope = { organizationId, projectId, requesterId };
  const requester = { workspaceId: organizationId, userId: requesterId };
  const access = createFakeContextAccess();
  access.grant(requester, { teamIds: ["a"], repositories: [], channelIds: [] });
  const reads = createFakeProjectContextReads();
  const project = { id: projectId, name: "Exports", url: "https://x.invalid", revision: "p1" };
  reads.projects.set(projectId, { ...project, revisionAt: T0, teamIds: ["a"], content: "CSV." });
  const ingest = { workspaceId: organizationId, projectId, requester, now: T0 };
  await ingestLinearProjectContext(db, access, reads, ingest);
  const service = createProjectSessionContext({ db, access });
  const lines: string[] = [];
  let at = T0;
  const publish = (title: string, description: string, outside = false) =>
    recordPullRequestSummary({
      service,
      pawsRoot,
      workItemId: `item-${seq}`,
      scope: async () => (outside ? "none" : scope),
      pullUrl: async () => "https://github.com/acme/app/pull/1",
      title,
      description,
      now: (at += 1000),
      journal: (line) => lines.push(line),
    });
  const stored = () =>
    currentSourceContextRecords(
      db,
      { workspaceId: organizationId, scopeKind: "linear_project", scopeId: projectId },
      { kind: "paws_work_item", id: `item-${seq}` },
      at,
    );
  const fail = () => access.grants.set(`${organizationId}\0${requesterId}`, new Error("Offline."));
  return { publish, stored, lines, fail };
}

test("opening a pull request records the title and first paragraph, and an update replaces it", async () => {
  const { publish, stored, lines } = await fixture();
  await publish("Export archived rows", `${"a".repeat(700)}\n\nSecond paragraph.`);
  const [first] = await stored();
  expect(first).toMatchObject({
    classification: "reported_fact",
    importance: 0,
    actorId: `alice-${seq}`,
    sourceUrl: "https://github.com/acme/app/pull/1",
    body: `Export archived rows: ${"a".repeat(600)}`,
  });
  await publish("Export active rows", "Writes CSV of active rows.");
  const rows = await stored();
  expect(rows.map((row) => row.body)).toEqual(["Export active rows: Writes CSV of active rows."]);
  expect(rows[0]!.supersedes).toBe(first!.id);
  expect(lines).toEqual([]);
});

test("with the setting off, or for an item outside a project, nothing is recorded", async () => {
  const off = await fixture(false);
  await off.publish("Export rows", "Writes CSV.");
  const outside = await fixture();
  await outside.publish("Export rows", "Writes CSV.", true);
  expect([...(await off.stored()), ...(await outside.stored())]).toEqual([]);
  expect([...off.lines, ...outside.lines]).toEqual([]);
});

test("a recording error journals one line and resolves", async () => {
  const { publish, stored, lines, fail } = await fixture();
  fail();
  await expect(publish("Export rows", "Writes CSV.")).resolves.toBeUndefined();
  expect(await stored()).toEqual([]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("operation=recordPullRequestSummary");
});
