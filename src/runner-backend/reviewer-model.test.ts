import { expect, test } from "bun:test";
import { catalogModels, reviewerModelAlternatives } from "./index";

const matches = "reviewer model matches implementation model";
const codex = JSON.stringify({ identity: { model: "gpt-same" }, models: [{ id: "gpt-other" }] });
const claude = JSON.stringify({ models: [{ id: "opus" }] });
const catalogs = new Map([
  ["a", { codex, claude: null }],
  ["b", { codex: JSON.stringify({ models: [{ id: "gpt-b" }] }), claude }],
  ["c", { codex: null, claude }],
  ["x", { codex: JSON.stringify({ models: [{ id: "gpt-foreign" }] }), claude: null }],
]);
const ask = (rejected: string[]) =>
  reviewerModelAlternatives({ rejected, agent: "codex", implementation: "gpt-same", catalogs });

test("a revoked or another member's runner beside conflicting ones still asks", () => {
  expect(ask([`a: ${matches}`, "x: revoked"])).toEqual(["codex gpt-other"]);
  expect(ask([`a: ${matches}`, "x: not-yours"])).toEqual(["codex gpt-other"]);
});

test("a runner without the reviewer agent beside conflicting ones still asks", () => {
  expect(ask([`a: ${matches}`, "c: agent-not-signed-in"])).toEqual(["codex gpt-other"]);
});

test("alternatives come from the catalogs of usable runners only", () => {
  expect(ask([`a: ${matches}`, `b: ${matches}`, "x: revoked"])).toEqual([
    "codex gpt-other",
    "codex gpt-b",
    "claude opus",
  ]);
});

test("a usable runner that can free up still waits", () => {
  for (const waits of ["offline", "paused", "no free capacity (work 1 of 1)", "auth-expired"])
    expect(ask([`a: ${matches}`, `b: ${waits}`])).toBeNull();
  expect(ask(["x: revoked", "c: agent-not-signed-in"])).toBeNull();
  expect(ask([])).toBeNull();
});

test("a runner offers its catalog's concrete models", () => {
  const catalog = { identity: { model: "a" }, models: [{ id: "default" }, { id: "b" }] };
  expect(catalogModels(JSON.stringify(catalog))).toEqual(["a", "b"]);
  expect(catalogModels(undefined)).toEqual([]);
});
