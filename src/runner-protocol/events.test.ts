import { expect, test } from "bun:test";
import { RunnerEventSchema, parseRememberOperations } from "./index";

test("a remember event round-trips through the runner event schema", () => {
  const event = {
    type: "remember",
    operations: [
      { action: "add", kind: "fact", content: "Invoices round half to even." },
      { action: "patch", kind: "open_question", old_text: "Old?", content: "New?" },
      { action: "remove", kind: "fact", old_text: "Stale." },
    ],
  };
  const parsed = RunnerEventSchema.parse(JSON.parse(JSON.stringify(event)));
  expect(parsed).toEqual(event as typeof parsed);
  expect(RunnerEventSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
});

test("a remember event refuses missing fields, extra fields and too many operations", () => {
  const add = { action: "add", kind: "fact", content: "A." };
  for (const operations of [
    [],
    Array.from({ length: 6 }, () => add),
    [{ action: "add", kind: "fact" }],
    [{ action: "remove", kind: "fact" }],
    [{ ...add, content: "x".repeat(401) }],
    [{ ...add, kind: "decision" }],
    [{ ...add, scope: "workspace" }],
  ])
    expect(RunnerEventSchema.safeParse({ type: "remember", operations }).success).toBe(false);
  expect(parseRememberOperations([{ action: "patch", kind: "fact", content: "B." }])).toEqual({
    ok: false,
    error: expect.stringContaining("operations.0.old_text: old_text is required"),
  });
});
