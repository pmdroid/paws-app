import { expect, test } from "bun:test";
import type { LinearClient } from "./graphql";
import { createLinearIssueDelegation } from "./issue-delegation";

const PAWS = "paws-app-user";

function delegation(issue: unknown) {
  const fake: LinearClient = { query: async () => ({ issue }) };
  return createLinearIssueDelegation(fake);
}

test("an open issue delegated to Paws is still Paws' work", async () => {
  const read = delegation({ delegate: { id: PAWS }, state: { type: "backlog" } });
  expect(await read("PAS-1", PAWS)).toBe(true);
});

test("an issue delegated to someone else, or to nobody, is not", async () => {
  expect(
    await delegation({ delegate: { id: "other" }, state: { type: "started" } })("PAS-1", PAWS),
  ).toBe(false);
  expect(await delegation({ delegate: null, state: { type: "backlog" } })("PAS-1", PAWS)).toBe(
    false,
  );
});

test("a canceled or completed issue is not, even if Paws is still its delegate", async () => {
  expect(
    await delegation({ delegate: { id: PAWS }, state: { type: "canceled" } })("PAS-1", PAWS),
  ).toBe(false);
  expect(
    await delegation({ delegate: { id: PAWS }, state: { type: "completed" } })("PAS-1", PAWS),
  ).toBe(false);
});

test("a missing issue is not Paws' work", async () => {
  expect(await delegation(null)("PAS-1", PAWS)).toBe(false);
});
