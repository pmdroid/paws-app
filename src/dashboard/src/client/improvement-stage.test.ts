import { expect, test } from "bun:test";
import { stageAllows, type ImprovementAction } from "./improvement-stage";
import type { ImprovementItem } from "../improvements";

const ACTIONS: ImprovementAction[] = [
  "create",
  "link",
  "reject",
  "use-issue",
  "reopen",
  "retry",
  "cancel-comment",
  "destination",
  "delegate",
  "criterion",
  "verification",
  "recovery",
];
test("each inbox stage allows only its own actions", () => {
  const allowed = (item: Parameters<typeof stageAllows>[0]) =>
    ACTIONS.filter((action) => stageAllows(item, action));
  expect(allowed({ lifecycle: "needs_review", reviewState: "needs_review" })).toEqual([
    "create",
    "link",
    "reject",
    "use-issue",
  ]);
  expect(allowed({ lifecycle: "rejected", reviewState: "rejected" })).toEqual(["reopen"]);
  expect(allowed({ lifecycle: "linked", reviewState: "accepted" })).toEqual([
    "retry",
    "cancel-comment",
    "destination",
    "delegate",
    "criterion",
    "verification",
    "recovery",
  ]);
});

test("an accepted item allows reopen only while a stranded link delivery offers it", () => {
  const item = (recovery: ImprovementItem["deliveries"][number]["recovery"]) => ({
    lifecycle: "pending" as const,
    reviewState: "accepted" as const,
    deliveries: [{ recovery }] as ImprovementItem["deliveries"],
  });
  expect(stageAllows(item("reopen"), "reopen")).toBe(true);
  expect(stageAllows(item("retry"), "reopen")).toBe(false);
  expect(stageAllows(item("reopen"), "retry")).toBe(true);
});
