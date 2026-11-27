import { expect, test } from "bun:test";
import { attributionReturnHandoff } from "./attribution-return";

const refused =
  "Run failed during push: Commit attribution rejected. Candidate attribution rejected: Co-authored-by trailers must match the consenting identities in the run policy. Commit 0123456789ab has unexpected Co-authored-by: Claude <noreply@anthropic.com>; expected no Co-authored-by trailers. No candidate was rewritten.";

test("a trailer refusal returns the turn once with the precise rejection", () => {
  const handoff = attributionReturnHandoff(refused, undefined);
  expect(handoff).toContain(
    "Commit 0123456789ab has unexpected Co-authored-by: Claude <noreply@anthropic.com>",
  );
  expect(handoff).not.toContain("Run failed during push");
  expect(attributionReturnHandoff(refused, handoff!)).toBeNull();
  expect(attributionReturnHandoff("Run failed during push: Error.", undefined)).toBeNull();
  expect(attributionReturnHandoff(undefined, undefined)).toBeNull();
});
