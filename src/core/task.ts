export const TASK_MODES = ["code", "answer", "artifact", "plan"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

/** Modes that end in one Linear response instead of a pull request. */
export type ResponseTaskMode = Exclude<TaskMode, "code">;

export function isResponseTaskMode(mode: TaskMode | null | undefined): mode is ResponseTaskMode {
  return mode === "answer" || mode === "artifact" || mode === "plan";
}

/** Response modes whose agent turn may not write files: an answer and a plan proposal. */
export function isReadOnlyTaskMode(mode: TaskMode | null | undefined): boolean {
  return mode === "answer" || mode === "plan";
}
