export const RUNNER_FULL = "no free capacity";

export type ItemRunnerVerdict = {
  id: string;
  name: string;
  rejection: string | null;
  hostConfig: "repository" | "sign-in" | null;
  cooldown?: { account: string; until: number | null };
};

export type QueueWaitingFor = {
  kind: "slots" | "quota" | "runner";
  text: string;
  until?: number;
};

export type ItemRunnerVerdicts = {
  repository: string | null;
  agent: string;
  runners: ItemRunnerVerdict[];
};

export type RunnerHostRefusal = {
  runnerId: string;
  runnerName: string;
  repository: string;
  kind: "repository" | "sign-in";
  agent: string;
};
