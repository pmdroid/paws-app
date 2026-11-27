import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { throwawayEnvironment } from "../scripts/throwaway-environment";
import { runProof } from "./proofs/harness";
import scenario from "./proofs/merge-repeated-failure";

const saved = { ...process.env };
const roots: string[] = [];
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("three identical merge failures in a row ask one question naming the error", async () => {
  const { root, env } = throwawayEnvironment();
  roots.push(root);
  const { PATH: _path, ...rest } = env;
  Object.assign(process.env, rest);
  const result = await runProof("merge-repeated-failure", scenario, root);
  expect(result.assertions.filter((entry) => !entry.passed)).toEqual([]);
}, 240_000);
