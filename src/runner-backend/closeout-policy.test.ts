import { expect, test } from "bun:test";
import { decodePolicyChunk, decodePolicyFiles, type PolicyFilesLoad } from "../acp";
import { answerPolicyRequest } from "./closeout-policy";

const policy: PolicyFilesLoad = {
  ok: true,
  absent: false,
  digest: `sha256:${"a".repeat(64)}`,
  files: new Map([[".closeout/policy.toml", new TextEncoder().encode("version = 1\n")]]),
};

test("a Closeout policy request without an offset is refused as malformed", () => {
  const answer = answerPolicyRequest(policy, { type: "closeout_policy" });
  expect(decodePolicyChunk(answer)).toBeNull();
  expect(decodePolicyFiles(answer)).toEqual({
    ok: false,
    message: "Paws refused a malformed Closeout policy request",
  });
});

test("a Closeout policy request with an offset gets a chunk", () => {
  const chunk = decodePolicyChunk(
    answerPolicyRequest(policy, { type: "closeout_policy", offset: 0 }),
  );
  expect(chunk?.offset).toBe(0);
  expect(decodePolicyFiles(chunk!.data)).toEqual(policy);
});
