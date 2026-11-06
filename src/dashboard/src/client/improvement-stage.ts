import type { ImprovementItem } from "../improvements";

export type ImprovementStage = "findings" | "review" | "rejected" | "accepted";

export type ImprovementAction =
  | "create"
  | "link"
  | "reject"
  | "use-issue"
  | "reopen"
  | "retry"
  | "cancel-comment"
  | "destination"
  | "delegate"
  | "criterion"
  | "verification"
  | "recovery";

const ALLOWED: Record<ImprovementStage, ReadonlySet<ImprovementAction>> = {
  findings: new Set(),
  review: new Set(["create", "link", "reject", "use-issue"]),
  rejected: new Set(["reopen"]),
  accepted: new Set([
    "retry",
    "cancel-comment",
    "destination",
    "delegate",
    "criterion",
    "verification",
    "recovery",
  ]),
};

type Staged = Pick<ImprovementItem, "legacy" | "lifecycle" | "reviewState"> &
  Partial<Pick<ImprovementItem, "deliveries">>;

export function improvementStage(item: Staged): ImprovementStage {
  if (item.legacy.some((action) => action.kind !== "dismissed")) return "findings";
  if (item.lifecycle === "needs_review") return "review";
  if (item.lifecycle === "rejected") return "rejected";
  return "accepted";
}

export function stageAllows(item: Staged, action: ImprovementAction): boolean {
  if (action === "reopen" && improvementStage(item) === "accepted")
    return (item.deliveries ?? []).some((delivery) => delivery.recovery === "reopen");
  if (action === "reopen" && item.reviewState !== "rejected") return false;
  return ALLOWED[improvementStage(item)].has(action);
}
