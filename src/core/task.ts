export const TASK_MODES = ["code", "answer", "artifact"] as const;
export type TaskMode = (typeof TASK_MODES)[number];
