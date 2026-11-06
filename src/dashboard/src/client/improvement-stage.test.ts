import { expect, test } from "bun:test";
import { improvementStage, stageAllows, type ImprovementAction } from "./improvement-stage";
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
const legacy = (kind: "filed" | "added" | "dismissed" | "claimed") => ({
  kind,
  issue: kind === "dismissed" ? null : "PAS-77",
  reason: null,
  by: null,
  at: null,
});

test("an item a Findings action filed, added or claims allows no inbox action in any lifecycle", () => {
  for (const kind of ["filed", "added", "claimed"] as const)
    for (const lifecycle of ["needs_review", "pending", "linked", "rejected"] as const) {
      const item = { legacy: [legacy(kind)], lifecycle, reviewState: "needs_review" as const };
      expect(improvementStage(item)).toBe("findings");
      expect(ACTIONS.filter((action) => stageAllows(item, action))).toEqual([]);
    }
});

test("each inbox stage allows only its own actions", () => {
  const allowed = (item: Parameters<typeof stageAllows>[0]) =>
    ACTIONS.filter((action) => stageAllows(item, action));
  expect(allowed({ legacy: [], lifecycle: "needs_review", reviewState: "needs_review" })).toEqual([
    "create",
    "link",
    "reject",
    "use-issue",
  ]);
  expect(allowed({ legacy: [], lifecycle: "rejected", reviewState: "rejected" })).toEqual([
    "reopen",
  ]);
  expect(
    allowed({ legacy: [legacy("dismissed")], lifecycle: "rejected", reviewState: "needs_review" }),
  ).toEqual([]);
  expect(allowed({ legacy: [], lifecycle: "linked", reviewState: "accepted" })).toEqual([
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
    legacy: [],
    lifecycle: "pending" as const,
    reviewState: "accepted" as const,
    deliveries: [{ recovery }] as ImprovementItem["deliveries"],
  });
  expect(stageAllows(item("reopen"), "reopen")).toBe(true);
  expect(stageAllows(item("retry"), "reopen")).toBe(false);
  expect(stageAllows(item("reopen"), "retry")).toBe(true);
});
