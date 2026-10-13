import { expect, test } from "bun:test";
import { probeLinearSchedulingMetadata } from "./local/linear-scheduling-metadata";

test("Linear scheduling metadata survives real HTTP and fails closed on malformed snapshots", async () => {
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  await probeLinearSchedulingMetadata((name, passed, observed) =>
    observations.push({ name, passed, observed }),
  );
  expect(observations).toHaveLength(5);
  expect(observations.every((item) => item.passed)).toBe(true);
});
