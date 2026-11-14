import { expect, spyOn, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { insertQueuedItem, type Q, type Steps } from "../src/db";
import * as intake from "../src/intake";
import { workspaceDispatchPg as workspaceDispatch } from "./fake-workspace";
import { tempStore } from "./pglite";

test("dispatch reports a delegation's dependency cycle and skips readiness reads for a delegation without edges", async () => {
  const { db, close } = await tempStore();
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
      await insertQueuedItem(db, { id, now: 1, sessionKey: `session-${delegationId}` });
      await db.run((q) =>
        q.exec(q.orm.update(q.t.workItem).set({ delegationId }).where(eq(q.t.workItem.id, id))),
      );
    }
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.taskBlock).values([
          { blockerLinearIssueId: "lin-item-acme-a", blockedLinearIssueId: "lin-item-acme-b" },
          { blockerLinearIssueId: "lin-item-acme-b", blockedLinearIssueId: "lin-item-acme-a" },
        ]),
      ),
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
      reported: (
        await db.run((q) =>
          q.all(
            q.orm
              .select({ key: q.t.outbox.idempotencyKey })
              .from(q.t.outbox)
              .where(like(q.t.outbox.idempotencyKey, "dependency-cycle:%")),
          ),
        )
      ).map(({ key }) => key.split(":")[1]),
    }).toEqual({ checked: ["acme-a", "acme-b"], reported: ["acme-cycle"] });
  } finally {
    ready.mockRestore();
    await close();
  }
});
