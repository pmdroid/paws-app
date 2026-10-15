import { expect, test } from "bun:test";
import { tempHome } from "./helpers";
import { RunnerEventSchema } from "../src/runner-protocol";
import { probeRunnerPublicActivity } from "./local/runner-public-activity";

test("remote public tool and message history survives restart and remains fully readable", async () => {
  const observations = await probeRunnerPublicActivity(tempHome());
  expect(observations).toHaveLength(2);
  expect(observations.every((entry) => entry.passed)).toBe(true);
}, 15000);

test("public activity redaction stays identical across durable replay", () => {
  const first = RunnerEventSchema.parse({
    type: "activity",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool",
      title: "Run browser",
      status: "completed",
      rawInput: { token: "input-secret" },
      rawOutput: '{"access_token":"output-secret"}',
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "token=plain-secret; Authorization: Bearer private-value",
          },
        },
      ],
    },
  });
  const second = RunnerEventSchema.parse(first);
  expect(second).toEqual(first);
  expect(RunnerEventSchema.parse(second)).toEqual(first);
  for (const value of ["input-secret", "output-secret", "plain-secret", "private-value"])
    expect(JSON.stringify(first)).not.toContain(value);
});
