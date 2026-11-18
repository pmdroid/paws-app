import { expect, test } from "bun:test";
import { remoteRemember } from "../src/runner-worker";

test("remember emits validated operations and returns Paws' answer or error", async () => {
  const emitted: unknown[] = [];
  const answers = [JSON.stringify({ answer: "Saved." }), JSON.stringify({ error: "Not saved." })];
  const remember = remoteRemember(
    (event) => emitted.push(event),
    async () => ({ answer: answers.shift()! }),
    new AbortController().signal,
  );
  const add = { action: "add", kind: "fact", content: "Exports use UTF-8." };
  expect(await remember([add])).toBe("Saved.");
  await expect(remember([add])).rejects.toThrow("Not saved.");
  await expect(remember(Array.from({ length: 6 }, () => add))).rejects.toThrow("Not saved");
  expect(emitted).toEqual([
    { type: "remember", requestId: expect.any(String), operations: [add] },
    { type: "remember", requestId: expect.any(String), operations: [add] },
  ]);
});
