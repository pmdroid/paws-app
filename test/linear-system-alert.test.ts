import { expect, test } from "bun:test";
import { createLinearTracker, type SystemAlert } from "../src/linear";

test("system alert comments reconcile an uncertain delivery without creating duplicates", async () => {
  let saved: SystemAlert | undefined;
  let mutations = 0;
  const tracker = createLinearTracker({
    async query(query, variables) {
      if (query.includes("query SystemAlert"))
        return { comments: { nodes: saved ? [{ ...saved, issue: { id: saved.issueId } }] : [] } };
      mutations++;
      saved = variables!.input as SystemAlert;
      throw new Error("response lost after comment creation");
    },
  });
  const alert = {
    id: "00000000-0000-4000-8000-000000000001",
    issueId: "issue",
    body: "Infrastructure fault holds ENG-1 and ENG-2",
  };
  await expect(tracker.postSystemAlert(alert)).rejects.toThrow("response lost");
  await tracker.postSystemAlert(alert);
  expect(mutations).toBe(1);
  await expect(tracker.postSystemAlert({ ...alert, issueId: "other" })).rejects.toThrow(
    "does not match",
  );
});
