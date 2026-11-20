import { expect, test } from "bun:test";
import { RunnerEventSchema } from "../src/runner-protocol";
import { remoteTools } from "../src/runner-worker";

const definitions = [{ name: "linear_issue", description: "Read an issue.", inputSchema: {} }];

test("a defined tool emits one event per call and resolves with Paws' answer", async () => {
  const emitted: ({ requestId: string } & Record<string, unknown>)[] = [];
  const answers = [
    JSON.stringify({ text: "PAS-1: Fix rounding" }),
    JSON.stringify({ text: "That tool is not available.", isError: true }),
  ];
  const tools = remoteTools(
    definitions,
    (event) => emitted.push(event),
    async () => ({ answer: answers.shift()! }),
    new AbortController().signal,
  );
  expect(await tools.call("linear_issue", { id: "PAS-1" })).toEqual({
    text: "PAS-1: Fix rounding",
  });
  expect(await tools.call("linear_issue", { id: "PAS-2" })).toEqual({
    text: "That tool is not available.",
    isError: true,
  });
  expect(emitted).toEqual([
    {
      type: "tool",
      requestId: expect.any(String),
      name: "linear_issue",
      arguments: { id: "PAS-1" },
    },
    {
      type: "tool",
      requestId: expect.any(String),
      name: "linear_issue",
      arguments: { id: "PAS-2" },
    },
  ]);
  for (const { requestId: _requestId, ...event } of emitted)
    expect(RunnerEventSchema.parse(event)).toEqual(
      event as ReturnType<typeof RunnerEventSchema.parse>,
    );
});

test("oversized arguments and the 201st call return an error and emit nothing", async () => {
  let emitted = 0;
  const tools = remoteTools(
    definitions,
    () => emitted++,
    async () => ({ answer: JSON.stringify({ text: "ok" }) }),
    new AbortController().signal,
  );
  expect(await tools.call("linear_issue", { text: "x".repeat(16_384) })).toMatchObject({
    isError: true,
  });
  expect(await tools.call("linear_comment", {})).toMatchObject({ isError: true });
  expect(emitted).toBe(0);
  for (let i = 0; i < 200; i++)
    expect(await tools.call("linear_issue", {})).toEqual({ text: "ok" });
  expect(emitted).toBe(200);
  expect(await tools.call("linear_issue", {})).toMatchObject({ isError: true });
  expect(emitted).toBe(200);
});
