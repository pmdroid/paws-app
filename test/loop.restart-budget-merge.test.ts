import { expect, test } from "bun:test";
import { getWorkItem, listCiRounds, restart as rawRestart } from "../src/db";
import { restart } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { failingTest, mergeHarness } from "../src/merge/advance-harness";

test("CI failure at the lifetime limit asks without a send-back or failure", async () => {
  const h = await mergeHarness({ restart });
  try {
    await h.addItem("ENG-926");
    for (let count = 0; count < 10; count++)
      rawRestart(h.db, getWorkItem(h.db, "ENG-926")!, {
        reason: "answer",
        body: "human guidance",
        now: h.clock.now(),
      });
    await h.requeue("ENG-926");
    h.state.ci = failingTest;
    expect(await h.pass("ENG-926")).toEqual({ kind: "asked" });
    expect(getWorkItem(h.db, "ENG-926")?.state).toBe("awaiting_input");
    expect(findOpenQuestion(h.db, "ses-ENG-926")?.reason).toBe("restart_budget");
    expect(h.bodies().some((body) => /sent.*agent|fix .* of|CI failed:/i.test(body))).toBe(false);
    expect(listCiRounds(h.db, "ENG-926")).toEqual([]);
  } finally {
    await h.cleanup();
  }
});
