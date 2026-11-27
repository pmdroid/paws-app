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
  model?: string | null;
  runners: ItemRunnerVerdict[];
  pinnedRunnerId?: string;
};

export type RunnerHostRefusal = {
  runnerId: string;
  runnerName: string;
  repository: string;
  kind: "repository" | "sign-in";
  agent: string;
};

export function modelUnofferedReason(agent: string, model: string): string {
  return `${agent} does not offer ${model}`;
}

export function noRunnerOffersLine(verdicts: ItemRunnerVerdicts): string | null {
  const { agent, model, runners } = verdicts;
  return model &&
    runners.some((runner) => runner.rejection === modelUnofferedReason(agent, model)) &&
    !runners.some((runner) => runner.rejection === null || runner.rejection === RUNNER_FULL)
    ? `No runner offers ${agent} ${model}`
    : null;
}
