import { expect, test } from "bun:test";
import { RUNNER_LEASE_GRACE_MS, RUNNER_LEASE_MS, RUNNER_OFFLINE_BUDGET_MS } from "./commands";
import { PAWS_ALIVE_LEASE_SKEW_MS, creditedLeaseUntil } from "./lease";

const SKEW_MS = PAWS_ALIVE_LEASE_SKEW_MS;
const ALIVE_AT = 1_000_000;

function credit(input: {
  leaseUntil: number;
  expiresAt: number;
  now: number;
  budgetMs?: number;
  skewMs?: number;
}) {
  return creditedLeaseUntil({
    aliveAt: ALIVE_AT,
    budgetMs: RUNNER_OFFLINE_BUDGET_MS,
    skewMs: SKEW_MS,
    ...input,
  });
}

test("downtime within the budget moves a live lease and stops at expiresAt", () => {
  const leaseUntil = ALIVE_AT + RUNNER_LEASE_MS;
  const now = ALIVE_AT + 20 * 60_000;
  expect(credit({ leaseUntil, expiresAt: leaseUntil + 60 * 60_000, now })).toBe(
    leaseUntil + 20 * 60_000,
  );
  expect(credit({ leaseUntil, expiresAt: ALIVE_AT + 10 * 60_000, now })).toBe(
    ALIVE_AT + 10 * 60_000,
  );
});

test("downtime past the budget leaves the original remaining lease", () => {
  const leaseUntil = ALIVE_AT + 10_000;
  expect(
    credit({
      leaseUntil,
      expiresAt: leaseUntil + 60 * 60_000,
      now: ALIVE_AT + 40 * 60_000,
    }),
  ).toBe(leaseUntil + RUNNER_OFFLINE_BUDGET_MS);
});

test("a lease already past its grace, or renewed past the skew, is unchanged", () => {
  const now = ALIVE_AT + 20 * 60_000;
  const givenUp = ALIVE_AT - RUNNER_LEASE_GRACE_MS;
  expect(credit({ leaseUntil: givenUp, expiresAt: now + 60_000, now })).toBe(givenUp);
  const renewed = ALIVE_AT + SKEW_MS + 1;
  expect(credit({ leaseUntil: renewed, expiresAt: renewed + 60_000, now })).toBe(renewed);
  const boundary = ALIVE_AT + SKEW_MS;
  expect(credit({ leaseUntil: boundary, expiresAt: boundary + 60 * 60_000, now })).toBe(
    boundary + 20 * 60_000,
  );
});

test("a clock that is not ahead of the alive mark adds nothing", () => {
  const leaseUntil = ALIVE_AT + RUNNER_LEASE_MS;
  expect(credit({ leaseUntil, expiresAt: leaseUntil + 60_000, now: ALIVE_AT })).toBe(leaseUntil);
});
