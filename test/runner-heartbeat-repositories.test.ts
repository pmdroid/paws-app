import { expect, test } from "bun:test";
import { createRunnerWorkHttp, type RunnerWork } from "../src/runner-work";

function heartbeatRequest(body: unknown) {
  return new Request("https://paws.test/v1/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a heartbeat passes the runner's repositories, null for all, to the work store", async () => {
  const seen: unknown[] = [];
  const work = {
    heartbeat: (...args: unknown[]) => {
      seen.push(args[8]);
      return { leases: [], fenced: [] };
    },
  } as unknown as RunnerWork;
  const http = createRunnerWorkHttp(work);
  for (const body of [{ repositories: ["acme/looky"] }, { repositories: null }, {}])
    expect((await http(heartbeatRequest(body), "runner"))?.status).toBe(200);
  expect(seen).toEqual([["acme/looky"], null, undefined]);
  expect(
    (await http(heartbeatRequest({ repositories: ["not a repo"] }), "runner"))?.status,
  ).not.toBe(200);
});
