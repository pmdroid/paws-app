import { expect, test } from "bun:test";
import { RunnerEventSchema } from "../src/runner-protocol";
import { remoteRecall } from "../src/runner-worker";

test("recall emits a valid event and returns Paws' answer or error", async () => {
  const emitted: ({ requestId: string } & Record<string, unknown>)[] = [];
  const answered: string[] = [];
  const answers = [
    JSON.stringify({ answer: '[{"id":"01R","body":"Exports use UTF-8."}]' }),
    JSON.stringify({ error: "recall is unavailable for this run" }),
  ];
  const recall = remoteRecall(
    (event) => emitted.push(event),
    async (requestId) => {
      answered.push(requestId);
      return { answer: answers.shift()! };
    },
    new AbortController().signal,
  );
  expect(await recall({ query: "exports" })).toBe('[{"id":"01R","body":"Exports use UTF-8."}]');
  await expect(recall({ id: "01R" })).rejects.toThrow("recall is unavailable");
  await expect(recall({ query: "exports", id: "01R" })).rejects.toThrow("Not recalled");
  await expect(recall({})).rejects.toThrow("Not recalled");
  expect(emitted).toEqual([
    { type: "recall", requestId: expect.any(String), query: "exports" },
    { type: "recall", requestId: expect.any(String), id: "01R" },
  ]);
  expect(answered).toEqual(emitted.map((event) => event.requestId));
  for (const { requestId: _requestId, ...event } of emitted)
    expect(RunnerEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(
      event as ReturnType<typeof RunnerEventSchema.parse>,
    );
});
