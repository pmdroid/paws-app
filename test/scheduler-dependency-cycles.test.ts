import { expect, spyOn, test } from "bun:test";
import { insertQueuedItem, type Q, type Steps } from "../src/db";
import * as intake from "../src/intake";
import { tempDb } from "./helpers";
import { workspaceDispatch } from "./fake-workspace";

test("dispatch reports a delegation's dependency cycle and skips readiness reads for a delegation without edges", async () => {
  const db = tempDb();
  const readyItemsSteps = intake.readyItemsSteps;
  const cycleChecks: string[] = [];
  const ready = spyOn(intake, "readyItemsSteps").mockImplementation((q, target) => {
    if (new Error().stack?.includes("reportDependencyCycles")) cycleChecks.push(target.itemId);
    return readyItemsSteps(q, target);
  });
  try {
    for (const [id, delegationId] of [
      ["acme-a", "acme-cycle"],
      ["acme-b", "acme-cycle"],
      ["acme-c", "acme-plain"],
      ["acme-d", "acme-plain"],
    ] as const) {
      insertQueuedItem(db, { id, now: 1, sessionKey: `session-${delegationId}` });
      db.run("UPDATE work_item SET delegation_id=? WHERE id=?", [delegationId, id]);
    }
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES('lin-item-acme-a','lin-item-acme-b'),('lin-item-acme-b','lin-item-acme-a')",
    );
    // oxlint-disable-next-line require-yield
    function* sessionFor(_q: Q, itemId: string): Steps<string> {
      return `session-for-${itemId}`;
    }
    expect(await workspaceDispatch(db, { now: 1000, sessionFor })).toEqual(["acme-c", "acme-d"]);
    cycleChecks.length = 0;
    await workspaceDispatch(db, { now: 1001, sessionFor });
    expect({
      checked: cycleChecks.sort(),
      reported: db
        .query<{ key: string }, []>(
          "SELECT idempotency_key AS key FROM outbox WHERE idempotency_key LIKE 'dependency-cycle:%'",
        )
        .all()
        .map(({ key }) => key.split(":")[1]),
    }).toEqual({ checked: ["acme-a", "acme-b"], reported: ["acme-cycle"] });
  } finally {
    ready.mockRestore();
    db.close();
  }
});
