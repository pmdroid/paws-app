import { expect, test } from "bun:test";
import { reviewerModelAlternatives } from "./index";

const models = (...ids: string[]) => JSON.stringify({ models: ids.map((id) => ({ id })) });
const catalogs = [
  { codex: models("gpt-same", "gpt-other", "default"), claude: null },
  { codex: models("gpt-other"), claude: models("opus", "disabled-account") },
];

test("offers each catalog model once, without the implementation model", async () => {
  const runs = async () => true;
  expect(await reviewerModelAlternatives({ implementation: "gpt-same", catalogs, runs })).toEqual([
    "codex gpt-other",
    "claude opus",
    "claude disabled-account",
  ]);
});

test("leaves out a model no runner and account can run as the reviewer", async () => {
  const runs = async (_agent: string, model: string) => model !== "disabled-account";
  expect(await reviewerModelAlternatives({ implementation: "gpt-same", catalogs, runs })).toEqual([
    "codex gpt-other",
    "claude opus",
  ]);
});
