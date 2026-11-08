export const RUNNER_FULL = "no free capacity";

export type ItemRunnerVerdict = {
  id: string;
  name: string;
  rejection: string | null;
  hostConfig: "repository" | "sign-in" | null;
};

export type ItemRunnerVerdicts = {
  repository: string | null;
  agent: string;
  runners: ItemRunnerVerdict[];
  refusedEverywhere: boolean;
};

export type RunnerHostRefusal = {
  runnerId: string;
  runnerName: string;
  repository: string;
  kind: "repository" | "sign-in";
  agent: string;
};
