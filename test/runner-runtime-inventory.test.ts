import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunnerRuntimeInventory } from "../src/runner-runtime";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary() {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-inventory-"));
  roots.push(root);
  return root;
}

test("the inventory keeps each task's runtimes, lets a later report win, and survives a restart", () => {
  const root = temporary();
  let now = 1_000;
  const inventory = openRunnerRuntimeInventory({ root, now: () => now });
  expect(inventory.installed()).toEqual([]);
  inventory.record([
    { tool: "python", version: "3.12", status: "installed" },
    { tool: "node", version: "22", status: "failed", error: "mise exited with code 1." },
  ]);
  now += 1;
  inventory.record([{ tool: "go", version: "1.23", status: "installed" }]);
  expect(inventory.installed()).toEqual([
    { tool: "go", version: "1.23", status: "installed" },
    { tool: "node", version: "22", status: "failed", error: "mise exited with code 1." },
    { tool: "python", version: "3.12", status: "installed" },
  ]);
  now += 1;
  inventory.record([{ tool: "node", version: "22", status: "installed" }]);
  const reopened = openRunnerRuntimeInventory({ root, now: () => now });
  expect(reopened.installed()).toEqual([
    { tool: "go", version: "1.23", status: "installed" },
    { tool: "node", version: "22", status: "installed" },
    { tool: "python", version: "3.12", status: "installed" },
  ]);
});

test("the inventory refuses a malformed report and drops the oldest past its limit", () => {
  const root = temporary();
  const inventory = openRunnerRuntimeInventory({ root });
  expect(() =>
    inventory.record([{ tool: "npm:left-pad", version: "1.0.0", status: "installed" }]),
  ).toThrow();
  expect(() => inventory.record({ runtimes: [] })).toThrow();
  expect(inventory.installed()).toEqual([]);
  for (let index = 0; index < 70; index += 1)
    inventory.record([{ tool: "node", version: `${index}`, status: "installed" }]);
  const versions = inventory.installed().map((runtime) => runtime.version);
  expect(versions).toHaveLength(64);
  expect(versions).not.toContain("5");
  expect(versions).toContain("6");
});

test("an unreadable inventory starts empty and says so", () => {
  const root = temporary();
  writeFileSync(join(root, "runtimes.json"), "{not json");
  const errors: string[] = [];
  const inventory = openRunnerRuntimeInventory({
    root,
    onError: (error) => errors.push(error.message),
  });
  expect(inventory.installed()).toEqual([]);
  expect(errors).toEqual(["Runner runtime inventory was unreadable and starts empty."]);
});
