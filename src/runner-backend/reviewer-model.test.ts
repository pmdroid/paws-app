import { expect, test } from "bun:test";
import { reviewerModelAlternatives } from "./index";

const matches = "reviewer model matches implementation model";
const models = (...ids: string[]) => JSON.stringify({ models: ids.map((id) => ({ id })) });
const catalogs = new Map([
  ["a", { codex: models("gpt-same", "gpt-other") }],
  ["b", { codex: models("gpt-b"), claude: models("opus") }],
  ["c", { claude: models("sonnet") }],
  ["x", { codex: models("gpt-foreign") }],
]);
const ask = (rejected: string[]) =>
  reviewerModelAlternatives({ rejected, agent: "codex", implementation: "gpt-same", catalogs });

test("runners the item cannot use beside conflicting ones still ask", () => {
  for (const other of ["revoked", "not-yours", "repository not allowed on the runner's page"])
    expect(ask([`a: ${matches}`, `x: ${other}`])).toEqual(["codex gpt-other"]);
  expect(ask([`n: ${matches}`])).toEqual([]);
});

test("a runner without the reviewer agent beside conflicting ones still asks and offers its models", () => {
  expect(ask([`a: ${matches}`, "c: agent-not-signed-in"])).toEqual([
    "codex gpt-other",
    "claude sonnet",
  ]);
});

test("alternatives come from the catalogs of runners the item can use only", () => {
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
});
