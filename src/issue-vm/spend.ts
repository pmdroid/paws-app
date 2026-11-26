import {
  issueVmAwakeIntervalsSteps,
  issueVmSpendSettingsSteps,
  type IssueVmProvider,
  type Q,
} from "../db";

export const DEFAULT_MONTHLY_LIMIT_USD = 50;
export const PRICED_ISSUE_VM_PROVIDERS = ["boat", "instabox"] as const;
export type PricedIssueVmProvider = (typeof PRICED_ISSUE_VM_PROVIDERS)[number];

const HOUR = 3_600_000;

export type IssueVmSpendLimit = {
  monthlyLimitUsd: number;
  prices: Record<PricedIssueVmProvider, number | null>;
};

export type IssueVmSpend = IssueVmSpendLimit & { month: string; spentUsd: number };

export type IssueVmSpendCheck =
  | { ok: true }
  | { ok: false; reason: "no_price"; provider: PricedIssueVmProvider; message: string }
  | { ok: false; reason: "spend_limit"; spentUsd: number; limitUsd: number; message: string };

function priced(provider: IssueVmProvider): provider is PricedIssueVmProvider {
  return (PRICED_ISSUE_VM_PROVIDERS as readonly string[]).includes(provider);
}

function monthBounds(at: number) {
  const date = new Date(at);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return {
    month: `${year}-${String(month + 1).padStart(2, "0")}`,
    from: Date.UTC(year, month, 1),
    to: Date.UTC(year, month + 1, 1),
  };
}

export function* issueVmSpendLimitSteps(q: Q, workspaceId: string) {
  const row = yield* issueVmSpendSettingsSteps(q, workspaceId);
  return {
    monthlyLimitUsd: row?.monthlyLimitUsd ?? DEFAULT_MONTHLY_LIMIT_USD,
    prices: { boat: row?.boatHourlyUsd ?? null, instabox: row?.instaboxHourlyUsd ?? null },
  } satisfies IssueVmSpendLimit;
}

export function* issueVmSpendSteps(q: Q, input: { workspaceId: string; at: number }) {
  const limit = yield* issueVmSpendLimitSteps(q, input.workspaceId);
  const { month, from, to } = monthBounds(input.at);
  const until = Math.min(to, input.at);
  const intervals = yield* issueVmAwakeIntervalsSteps(q, {
    workspaceId: input.workspaceId,
    providers: [...PRICED_ISSUE_VM_PROVIDERS],
    from,
    to: until,
  });
  let spentUsd = 0;
  for (const interval of intervals) {
    if (!priced(interval.provider)) continue;
    const start = Math.max(interval.startedAt, from);
    const end = Math.min(interval.endedAt ?? until, until);
    if (end > start) spentUsd += ((end - start) / HOUR) * (limit.prices[interval.provider] ?? 0);
  }
  return { ...limit, month, spentUsd } satisfies IssueVmSpend;
}

const dollars = (value: number) => `$${value.toFixed(2)}`;

export function* issueVmSpendCheckSteps(
  q: Q,
  input: { workspaceId: string; provider: IssueVmProvider; at: number },
) {
  if (!priced(input.provider)) return { ok: true } satisfies IssueVmSpendCheck;
  const spend = yield* issueVmSpendSteps(q, input);
  if (spend.prices[input.provider] === null)
    return {
      ok: false,
      reason: "no_price",
      provider: input.provider,
      message: `No hourly price is set for ${input.provider} issue VMs`,
    } satisfies IssueVmSpendCheck;
  if (spend.spentUsd >= spend.monthlyLimitUsd)
    return {
      ok: false,
      reason: "spend_limit",
      spentUsd: spend.spentUsd,
      limitUsd: spend.monthlyLimitUsd,
      message: `Monthly issue VM spend limit reached (${dollars(spend.spentUsd)} of ${dollars(spend.monthlyLimitUsd)})`,
    } satisfies IssueVmSpendCheck;
  return { ok: true } satisfies IssueVmSpendCheck;
}
