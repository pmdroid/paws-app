import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFile, useSettingsStore } from "../src/config";
import { savedSettingsText, sectionSettings, seedSettings } from "./saved-settings";
import { handleIssueVmSettingsRequest, type IssueVmSettingsOptions } from "../src/settings";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const url = "http://127.0.0.1:8787/api/settings/issue-vm";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function instance() {
  const { db, close } = await tempStore();
  const home = tempHome();
  const configPath = join(home, "config.toml");
  await seedSettings(db, '[vm_sizes.exe-dev]\nimage = "ubuntu:24.04"\n');
  const settings = await useSettingsStore(configPath, sectionSettings(db));
  cleanups.push(close, () => {
    settings.release();
    rmSync(home, { recursive: true, force: true });
  });
  const audits: string[] = [];
  const options = (role: string): IssueVmSettingsOptions => ({
    configPath,
    csrfToken: "csrf",
    role,
    audit: async (action, subject) => {
      audits.push(`${action}: ${subject}`);
    },
  });
  return { db, configPath, options, audits };
}

function put(body: unknown): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
    body: JSON.stringify(body),
  });
}

test("an admin reads the defaults and saves new limits", async () => {
  const { db, configPath, options, audits } = await instance();
  const read = await handleIssueVmSettingsRequest(new Request(url), options("admin"));
  expect(await read!.json()).toEqual({ perMember: 2, workspaceMax: 10, deleteAfterDays: 7 });

  const saved = await handleIssueVmSettingsRequest(
    put({ perMember: 0, workspaceMax: 500, deleteAfterDays: 60 }),
    options("admin"),
  );
  expect(saved!.status).toBe(200);
  expect(await saved!.json()).toEqual({ perMember: 0, workspaceMax: 500, deleteAfterDays: 60 });
  const stored = await savedSettingsText(db);
  expect(stored).toContain(
    "[issue_vm]\nper_member = 0\nworkspace_max = 500\ndelete_after_days = 60",
  );
  expect(stored).toContain('image = "ubuntu:24.04"');
  expect(loadConfigFile(configPath).issueVm).toEqual({
    perMember: 0,
    workspaceMax: 500,
    deleteAfterDays: 60,
  });
  expect(audits).toEqual([
    "settings.issue_vm: Set issue VM limits: 0 per member, 500 in the workspace, deleted after 60 days asleep",
  ]);
});

test("a member can neither read nor change the limits", async () => {
  const { db, options } = await instance();
  const read = await handleIssueVmSettingsRequest(new Request(url), options("member"));
  expect(read!.status).toBe(403);
  const saved = await handleIssueVmSettingsRequest(put({ perMember: 9 }), options("member"));
  expect(saved!.status).toBe(403);
  expect(await savedSettingsText(db)).not.toContain("issue_vm");
});

test("values outside the ranges are refused", async () => {
  const { db, options } = await instance();
  for (const [body, message] of [
    [{ perMember: 51 }, "issue_vm.per_member must be a whole number from 0 to 50"],
    [{ workspaceMax: 0 }, "issue_vm.workspace_max must be a whole number from 1 to 500"],
    [{ deleteAfterDays: 61 }, "issue_vm.delete_after_days must be a whole number from 1 to 60"],
    [{ deleteAfterDays: 1.5 }, "issue_vm.delete_after_days must be a whole number from 1 to 60"],
    [{ perMember: "2" }, "issue_vm.per_member must be a whole number from 0 to 50"],
    [{ ceiling: 3 }, "issue_vm has an unknown field: ceiling"],
  ] as const) {
    const response = await handleIssueVmSettingsRequest(put(body), options("admin"));
    expect(response!.status).toBe(400);
    expect(((await response!.json()) as { error: string }).error).toStartWith(message);
  }
  expect(await savedSettingsText(db)).not.toContain("issue_vm");
});
