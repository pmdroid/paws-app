import assert from "node:assert/strict";
import { publishRunnerAnswer, readRunnerAnswer } from "../../src/runner-answers";

const [mode, root, executionId, runnerUid, agentGid, requestId] = process.argv.slice(2);
if (!root || !executionId || !requestId) throw new Error("Missing runner answer proof arguments");
const spool = { root, runnerUid: Number(runnerUid), agentGid: Number(agentGid) };
if (mode === "publish") {
  publishRunnerAnswer(spool, executionId, { requestId, answer: "Verified daemon answer" });
  console.log(JSON.stringify({ published: true }));
} else if (mode === "read") {
  assert.equal(readRunnerAnswer(spool, executionId, requestId)?.answer, "Verified daemon answer");
  console.log(JSON.stringify({ read: true }));
} else if (mode === "deny") {
  assert.throws(
    () => publishRunnerAnswer(spool, executionId, { requestId, answer: "Agent replacement" }),
    /Only the runner/,
  );
  console.log(JSON.stringify({ writeDenied: true }));
} else throw new Error("Invalid runner answer proof mode");
