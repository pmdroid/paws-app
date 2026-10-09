export type StatusItem = {
  id: string;
  identifier: string;
  title: string;
  state: string;
  epicId: string;
  turnCount: number;
  recoveryAttempts: number;
};

export type StatusRun = {
  id: string;
  itemId: string;
  kind: string;
  agent: string;
  status: string;
  updatedAt: number;
};

export type StatusReport = {
  ok: true;
  source: "engine" | "demo";
  service: "paws";
  mode: "local" | "hosted";
  now: string;
  publicUrl: string | null;
  listener: { host: string; port: number };
  counts: {
    epics: number;
    items: number;
    runs: number;
    jobsPending: number;
    jobsRunning: number;
    outboxPending: number;
  };
  items: StatusItem[];
  runs: StatusRun[];
};

/** Sample rows used when the engine is not attached. The page also embeds this shape. */
export function demoStatus(input?: {
  mode?: "local" | "hosted";
  publicUrl?: string | null;
}): StatusReport {
  const mode = input?.mode ?? "local";
  return {
    ok: true,
    source: "demo",
    service: "paws",
    mode,
    now: "2026-01-01T00:00:00.000Z",
    publicUrl: input?.publicUrl ?? null,
    listener: { host: mode === "hosted" ? "0.0.0.0" : "127.0.0.1", port: 8787 },
    counts: {
      epics: 1,
      items: 2,
      runs: 1,
      jobsPending: 1,
      jobsRunning: 0,
      outboxPending: 0,
    },
    items: [
      {
        id: "demo-item-1",
        identifier: "QM-1",
        title: "Sample: wire the status page",
        state: "running",
        epicId: "demo-epic",
        turnCount: 3,
        recoveryAttempts: 0,
      },
      {
        id: "demo-item-2",
        identifier: "QM-2",
        title: "Sample: waiting on review",
        state: "verifying",
        epicId: "demo-epic",
        turnCount: 8,
        recoveryAttempts: 1,
      },
    ],
    runs: [
      {
        id: "demo-run-1",
        itemId: "demo-item-1",
        kind: "implement",
        agent: "claude",
        status: "active",
        updatedAt: 1_767_225_600_000,
      },
    ],
  };
}
