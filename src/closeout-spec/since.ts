import type { ResolvedRequirement } from "./types";

export type SinceRun = { head: string; ids: readonly string[] };

const COMMIT = /^[0-9a-f]{40,64}$/;

export function sinceArgv(since: readonly string[], head: string): string[] {
  return since.map((part) => (part === "{since}" ? head : part));
}

export function withSince<P extends { items: ResolvedRequirement[] }>(
  policy: P,
  run: SinceRun | undefined,
): P {
  if (!run || run.ids.length === 0 || !COMMIT.test(run.head)) return policy;
  return {
    ...policy,
    items: policy.items.map((item) =>
      item.kind === "command" && "since" in item && item.since && run.ids.includes(item.id)
        ? { ...item, exec: sinceArgv(item.since, run.head) }
        : item,
    ),
  };
}
