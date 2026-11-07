import { afterEach, expect, test } from "bun:test";
import {
  endPushOutageSteps,
  getPushOutageSteps,
  listPushOutagesSteps,
  recordPushOutageSteps,
  setPushOutageQuestionSteps,
  takePushOutageProbeSteps,
} from "../src/db";
import { forEachDialect, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const refusal = (repository: string, now: number, jobId: number | null = 7) => ({
  repository,
  error: "refused",
  jobId,
  installationUrl: null,
  now,
  delayMs: (failedProbes: number) => 1_000 * (failedProbes + 1),
});

forEachDialect((connect) => {
  test("a push outage counts failed probes, keeps its installation link and ends once", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;

    const first = await db.run((q) =>
      recordPushOutageSteps(q, { ...refusal("acme/paws", 100), installationUrl: "https://x" }),
    );
    expect(first).toEqual({
      repository: "acme/paws",
      startedAt: 100,
      lastError: "refused",
      lastFailedAt: 100,
      failedProbes: 0,
      nextProbeAt: 1_100,
      probeJobId: 7,
      installationUrl: "https://x",
      questionId: null,
    });
    const second = await db.run((q) => recordPushOutageSteps(q, refusal("acme/paws", 200, 8)));
    expect(second).toMatchObject({
      startedAt: 100,
      lastFailedAt: 200,
      failedProbes: 1,
      nextProbeAt: 2_200,
      probeJobId: 8,
      installationUrl: "https://x",
    });
    await db.run((q) => recordPushOutageSteps(q, refusal("acme/older", 50)));

    await db.run((q) => takePushOutageProbeSteps(q, "acme/paws", 9));
    await db.run((q) => setPushOutageQuestionSteps(q, "acme/paws", "question-1"));
    expect(await db.run((q) => getPushOutageSteps(q, "acme/paws"))).toMatchObject({
      probeJobId: 9,
      questionId: "question-1",
    });
    expect((await db.run(listPushOutagesSteps)).map((outage) => outage.repository)).toEqual([
      "acme/older",
      "acme/paws",
    ]);

    expect(await db.run((q) => endPushOutageSteps(q, "acme/paws"))).toMatchObject({
      repository: "acme/paws",
    });
    expect(await db.run((q) => endPushOutageSteps(q, "acme/paws"))).toBeNull();
    expect(await db.run((q) => getPushOutageSteps(q, "acme/paws"))).toBeNull();
  });
});
