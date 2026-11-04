import { journal } from "./journal";

export function startPhaseClock(input: {
  ids: Readonly<Record<string, string>>;
  startedAt?: number;
  now?: () => number;
  write?: (line: string) => void;
}): (phase: string) => void {
  const now = input.now ?? Date.now;
  const write = input.write ?? journal;
  const ids = Object.entries(input.ids)
    .map(([key, value]) => `${key}=${value.replace(/\s/g, "_")}`)
    .join(" ");
  const marked = new Set<string>();
  let last = input.startedAt ?? now();
  return (phase) => {
    if (marked.has(phase)) return;
    marked.add(phase);
    const at = now();
    write(`start ${ids} phase=${phase} durationMs=${Math.max(0, at - last)}`);
    last = at;
  };
}
