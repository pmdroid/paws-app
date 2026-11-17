import { encodePolicyChunk, type PolicyFilesLoad } from "../acp";
import type { RunnerEvent } from "../runner-protocol";

export function answerPolicyRequest(
  policy: PolicyFilesLoad,
  request: Extract<RunnerEvent, { type: "closeout_policy" }>,
): string {
  if (request.offset === undefined)
    return JSON.stringify({ error: "Paws refused a malformed Closeout policy request" });
  return encodePolicyChunk(policy, request.offset, request.hash);
}
