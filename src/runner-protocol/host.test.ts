import { expect, test } from "bun:test";
import { RunnerHostStatusSchema } from "./host";

test("oversized host collections reject before validating their elements", () => {
  const result = RunnerHostStatusSchema.safeParse({
    strayProcesses: Array(5_000).fill(null),
  });
  expect(result.success).toBe(false);
  if (result.success) throw new Error("Oversized host collection was accepted");
  expect(result.error.issues).toHaveLength(1);
  expect(result.error.issues[0]).toMatchObject({
    code: "too_big",
    path: ["strayProcesses"],
    maximum: 20,
  });
});
