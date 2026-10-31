import { expect, test } from "bun:test";
import { getWorkItem, listCiRounds, listOutbox } from "../src/db";
import { restart } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { failingTest, mergeHarness } from "../src/merge/advance-harness";

test("CI failure at the lifetime limit asks without a send-back or failure", async () => {
  const h = await mergeHarness({ restart });
  try {
    await h.addItem("ENG-926");
    h.db.run("UPDATE work_item SET restart_count=10 WHERE id=?", ["ENG-926"]);
    h.state.ci = failingTest;
    expect(await h.pass("ENG-926")).toEqual({ kind: "asked" });
    expect(getWorkItem(h.db, "ENG-926")?.state).toBe("awaiting_input");
    expect(findOpenQuestion(h.db, "ses-ENG-926")?.reason).toBe("restart_budget");
    expect(h.bodies().some((body) => /sent.*agent|fix .* of|CI failed:/i.test(body))).toBe(false);
    expect(listCiRounds(h.db, "ENG-926")).toMatchObject([{ next: "asked" }]);
  } finally {
    await h.cleanup();
  }
});

test("a sessionless budget failure is already handled by the restart owner", async () => {
  const h = await mergeHarness({ restart });
  try {
    await h.addItem("ENG-926");
    h.db.run("UPDATE work_item SET restart_count=10,session_key=NULL WHERE id=?", ["ENG-926"]);
    h.state.ci = failingTest;
    expect(await h.pass("ENG-926")).toEqual({ kind: "obsolete" });
    expect(getWorkItem(h.db, "ENG-926")?.state).toBe("failed");
    expect(
      listOutbox(h.db).filter((row) => JSON.stringify(row.payload).includes("no Linear session")),
    ).toHaveLength(1);
    expect(h.bodies().some((body) => /CI failed:|Sent it back to the agent/i.test(body))).toBe(
      false,
    );
  } finally {
    await h.cleanup();
  }
});
