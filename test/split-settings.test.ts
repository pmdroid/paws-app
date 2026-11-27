import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { useSettingsStore } from "../src/config";
import { readSettingSectionsSteps } from "../src/db";
import { sectionSettings } from "./saved-settings";
import { handleSplitSettingsRequest, type SplitSettingsOptions } from "../src/settings";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const url = "http://127.0.0.1:8787/api/settings/splits";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function instance() {
  const { db, close } = await tempStore();
  const home = tempHome();
  const configPath = join(home, "config.toml");
  const settings = await useSettingsStore(configPath, sectionSettings(db));
  cleanups.push(close, () => {
    settings.release();
    rmSync(home, { recursive: true, force: true });
  });
  const audits: string[] = [];
  const options = (role: string): SplitSettingsOptions => ({
    configPath,
    csrfToken: "csrf",
    role,
    store: db,
    workspaceId: "workspace-1",
    audit: async (action, subject) => {
      audits.push(`${action}: ${subject}`);
    },
  });
  return { db, options, audits };
}

const put = (body: unknown) =>
  new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
    body: JSON.stringify(body),
  });

test("an admin reads the defaults and saves the splits section", async () => {
  const { db, options, audits } = await instance();
  const read = await handleSplitSettingsRequest(new Request(url), options("admin"));
  expect(await read!.json()).toEqual({
    enabled: true,
    maxSubIssues: 2,
    approvalsBeforeAuto: 2,
    approvedSplits: 0,
  });
  const body = { enabled: false, maxSubIssues: 5, approvalsBeforeAuto: 0 };
  const saved = await handleSplitSettingsRequest(put(body), options("admin"));
  expect(await saved!.json()).toEqual({ ...body, approvedSplits: 0 });
  expect(await db.run((q) => readSettingSectionsSteps(q, ["splits"]))).toEqual({
    splits: { enabled: false, max_sub_issues: 5, approvals_before_auto: 0 },
  });
  expect(audits).toEqual([
    "settings.splits: Set issue splits off: at most 5 sub-issues, 0 approvals before automatic splits",
  ]);
});

test("out-of-range values are refused and members can read but not change splits", async () => {
  const { options } = await instance();
  const tooMany = await handleSplitSettingsRequest(
    put({ enabled: true, maxSubIssues: 6, approvalsBeforeAuto: 2 }),
    options("admin"),
  );
  expect(tooMany!.status).toBe(400);
  expect(await tooMany!.json()).toEqual({
    error: "splits.maxSubIssues must be a whole number from 1 to 5",
  });
  expect((await handleSplitSettingsRequest(new Request(url), options("member")))!.status).toBe(200);
  const memberPut = await handleSplitSettingsRequest(
    put({ enabled: false, maxSubIssues: 2, approvalsBeforeAuto: 2 }),
    options("member"),
  );
  expect(memberPut!.status).toBe(403);
});
