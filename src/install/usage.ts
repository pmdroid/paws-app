export type AgentLimit = { window: string; usedPercent: number; resetsAt: number | null };

type Window = { utilization?: unknown; usedPercent?: unknown; resetsAt?: unknown };

const CLAUDE_WINDOWS: Record<string, string> = { five_hour: "5-hour", seven_day: "Weekly" };

function limit(window: string, percent: number, resetsAt: unknown): AgentLimit {
  return {
    window,
    usedPercent: Math.min(100, Math.max(0, percent)),
    resetsAt:
      typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0
        ? Math.round(resetsAt * 1000)
        : null,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function claudeLimits(rateLimit: unknown): AgentLimit[] {
  const info = record(rateLimit);
  const windows = record(info?.unifiedWindows) ?? {
    ...(typeof info?.rateLimitType === "string" ? { [info.rateLimitType]: info } : {}),
  };
  return Object.entries(CLAUDE_WINDOWS).flatMap(([key, label]) => {
    const entry = record(windows[key]) as Window | null;
    return typeof entry?.utilization === "number" && Number.isFinite(entry.utilization)
      ? [limit(label, entry.utilization * 100, entry.resetsAt)]
      : [];
  });
}

const CLAUDE_USAGE_WINDOWS: Record<string, string> = { session: "5-hour", weekly_all: "Weekly" };

export function claudeUsageLimits(report: unknown): AgentLimit[] {
  const limits = record(report)?.limits;
  if (!Array.isArray(limits)) return [];
  return Object.entries(CLAUDE_USAGE_WINDOWS).flatMap(([kind, label]) => {
    const entry = limits.map(record).find((value) => value?.kind === kind);
    if (typeof entry?.percent !== "number" || !Number.isFinite(entry.percent)) return [];
    const resetsAt =
      typeof entry.resets_at === "string" ? Date.parse(entry.resets_at) / 1000 : null;
    return [limit(label, entry.percent, resetsAt)];
  });
}

export function codexWindow(minutes: number): string {
  if (minutes === 7 * 24 * 60) return "Weekly";
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day`;
  return `${Math.round(minutes / 60)}-hour`;
}

export function codexLimits(result: unknown): AgentLimit[] {
  const limits = record(record(result)?.rateLimits);
  return [limits?.primary, limits?.secondary].flatMap((value) => {
    const entry = record(value) as (Window & { windowDurationMins?: unknown }) | null;
    if (
      typeof entry?.usedPercent !== "number" ||
      !Number.isFinite(entry.usedPercent) ||
      typeof entry.windowDurationMins !== "number" ||
      entry.windowDurationMins <= 0
    )
      return [];
    return [limit(codexWindow(entry.windowDurationMins), entry.usedPercent, entry.resetsAt)];
  });
}

export type RateLimitReader = (env: NodeJS.ProcessEnv, executable?: string) => Promise<unknown>;

async function readJsonLines(
  command: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  input: string,
  pick: (message: Record<string, unknown>) => unknown,
): Promise<unknown> {
  const child = Bun.spawn(command, {
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    child.stdin.write(input);
    await child.stdin.flush();
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 1_000_000) break;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const message = record(JSON.parse(line));
        const picked = message && pick(message);
        if (picked !== undefined) return picked;
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

/** `executable` is the `claude` CLI to run. `/usage` is a local command, so it spends no tokens. */
export function readClaudeRateLimits(
  env: NodeJS.ProcessEnv,
  executable = "claude",
  timeoutMs = 15_000,
): Promise<unknown> {
  return readJsonLines(
    [
      executable,
      "-p",
      "/usage",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
    ],
    env,
    timeoutMs,
    "",
    (message) =>
      record(message.usage_report)
        ? (record(message.usage_report)?.rate_limits ?? null)
        : message.type === "result"
          ? null
          : undefined,
  );
}

/** `executable` is the `codex` CLI to run. The runner passes its launcher's absolute path. */
export function readCodexRateLimits(
  env: NodeJS.ProcessEnv,
  executable = "codex",
  timeoutMs = 15_000,
): Promise<unknown> {
  return readJsonLines(
    [executable, "app-server"],
    env,
    timeoutMs,
    [
      { id: 1, method: "initialize", params: { clientInfo: { name: "paws", version: "0" } } },
      { method: "initialized" },
      { id: 2, method: "account/rateLimits/read" },
    ]
      .map((message) => `${JSON.stringify(message)}\n`)
      .join(""),
    (message) => (message.id === 2 ? (message.result ?? null) : undefined),
  );
}
