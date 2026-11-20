import { expect, test } from "bun:test";
import { RunnerEventSchema, parseRecallRequest, parseRememberOperations } from "./index";

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

test("a recall event round-trips with exactly one of query or id", () => {
  for (const event of [
    { type: "recall", query: "invoice rounding" },
    { type: "recall", id: "01RECORD" },
  ]) {
    const parsed = RunnerEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(parsed).toEqual(event as typeof parsed);
  }
  for (const event of [
    { type: "recall" },
    { type: "recall", query: "a", id: "b" },
    { type: "recall", query: "" },
    { type: "recall", query: "x".repeat(201) },
    { type: "recall", query: "a", scope: "workspace" },
  ])
    expect(RunnerEventSchema.safeParse(event).success).toBe(false);
  expect(parseRecallRequest({ query: "a", id: "b" })).toEqual({
    ok: false,
    error: expect.stringContaining("exactly one of query or id"),
  });
});

test("a tool event round-trips and refuses built-in names and oversized arguments", () => {
  const event = { type: "tool", name: "linear_issue", arguments: { id: "PAS-1", deep: [1, null] } };
  expect(RunnerEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(
    event as ReturnType<typeof RunnerEventSchema.parse>,
  );
  for (const bad of [
    { ...event, name: "ask_team" },
    { ...event, name: "Linear" },
    { ...event, arguments: { text: "x".repeat(16_384) } },
    { ...event, arguments: [] },
    { ...event, extra: 1 },
  ])
    expect(RunnerEventSchema.safeParse(bad).success).toBe(false);
});
