import { test } from "bun:test";
import assert from "node:assert/strict";
import { probeLinearDependencyPagination } from "./local/linear-dependency-pagination";

test("Linear graph reads complete their pages or reject the whole snapshot", async () => {
  const observations: string[] = [];
  await probeLinearDependencyPagination((name, passed) => {
    assert(passed, name);
    observations.push(name);
  });
  assert.equal(observations.length, 18);
}, 30_000);
