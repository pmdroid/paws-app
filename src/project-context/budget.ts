export type ContextBudgetSettings = {
  readonly hardCapTokens: number;
  readonly responseTokens: number;
  readonly memoryTokens: number;
  readonly recentTokens: number;
  readonly softThresholdTokens: number;
  readonly candidates: number;
  readonly references: number;
  readonly recentEntries: number;
  readonly requestBytes: number;
  readonly summaryInputTokens: number;
  readonly summaryOutputTokens: number;
  readonly summaryTimeoutMs: number;
  readonly compactionLeaseMs: number;
  readonly compactionRetryMs: number;
};

export const CONTEXT_BUDGET_DEFAULTS: ContextBudgetSettings = {
  hardCapTokens: 200_000,
  responseTokens: 8_000,
  memoryTokens: 6_000,
  recentTokens: 4_000,
  softThresholdTokens: 4_500,
  candidates: 200,
  references: 20,
  recentEntries: 20,
  requestBytes: 64_000,
  summaryInputTokens: 12_000,
  summaryOutputTokens: 1_500,
  summaryTimeoutMs: 60_000,
  compactionLeaseMs: 120_000,
  compactionRetryMs: 600_000,
};

const BOUNDS: Record<keyof ContextBudgetSettings, readonly [number, number]> = {
  hardCapTokens: [1_000, 2_000_000],
  responseTokens: [1, 200_000],
  memoryTokens: [100, 100_000],
  recentTokens: [0, 100_000],
  softThresholdTokens: [50, 100_000],
  candidates: [1, 200],
  references: [0, 50],
  recentEntries: [0, 100],
  requestBytes: [1_000, 1_000_000],
  summaryInputTokens: [200, 50_000],
  summaryOutputTokens: [50, 10_000],
  summaryTimeoutMs: [1_000, 300_000],
  compactionLeaseMs: [5_000, 3_600_000],
  compactionRetryMs: [60_000, 86_400_000],
};

export type ContextModelBudget = {
  readonly contextTokens: number;
  readonly outputTokens?: number;
  readonly countTokens?: (text: string) => number;
};

export type ContextBudgetValidation =
  | { ok: true; settings: ContextBudgetSettings }
  | { ok: false; errors: string[] };

export function validateContextBudget(
  overrides: Partial<ContextBudgetSettings> = {},
): ContextBudgetValidation {
  const settings = { ...CONTEXT_BUDGET_DEFAULTS, ...overrides };
  const errors: string[] = [];
  for (const [key, [min, max]] of Object.entries(BOUNDS) as [
    keyof ContextBudgetSettings,
    readonly [number, number],
  ][]) {
    const value = settings[key];
    if (!Number.isSafeInteger(value) || value < min || value > max)
      errors.push(`${key} must be a whole number from ${min} to ${max}.`);
  }
  if (errors.length) return { ok: false, errors };
  if (settings.softThresholdTokens >= settings.memoryTokens)
    errors.push("softThresholdTokens must be below memoryTokens.");
  if (settings.summaryOutputTokens >= settings.softThresholdTokens)
    errors.push("summaryOutputTokens must be below softThresholdTokens.");
  if (
    settings.memoryTokens + settings.recentTokens + settings.responseTokens >=
    settings.hardCapTokens
  )
    errors.push("memoryTokens, recentTokens and responseTokens must fit below hardCapTokens.");
  return errors.length ? { ok: false, errors } : { ok: true, settings };
}

export function validModelBudget(model: ContextModelBudget): boolean {
  return (
    Number.isSafeInteger(model.contextTokens) &&
    model.contextTokens > 0 &&
    (model.outputTokens === undefined ||
      (Number.isSafeInteger(model.outputTokens) && model.outputTokens >= 0))
  );
}

export const CONTEXT_TOKEN_ESTIMATE = { bytesPerToken: 2, perSegment: 4 } as const;

export function estimateContextTokens(text: string): number {
  if (text === "") return 0;
  return (
    Math.ceil(Buffer.byteLength(text, "utf8") / CONTEXT_TOKEN_ESTIMATE.bytesPerToken) +
    CONTEXT_TOKEN_ESTIMATE.perSegment
  );
}

export function tokenCounter(model: ContextModelBudget): (text: string) => number {
  const count = model.countTokens;
  if (!count) return estimateContextTokens;
  return (text) => {
    const counted = count(text);
    return Number.isFinite(counted) && counted >= 0
      ? Math.ceil(counted)
      : estimateContextTokens(text);
  };
}
