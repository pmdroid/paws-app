import { expect, test } from "bun:test";
import { canAnswer } from "../src/questions";
import { canAct, isWorkspaceAdmin, type ActionActor } from "../src/workspace";

const identity = {
  userId: "human",
  organizationId: "org",
  active: true,
  guest: false,
  admin: false,
  teamIds: ["team"],
};
const actor = (role: "admin" | "member", active = true): ActionActor => ({
  id: "human",
  identity,
  teamId: "team",
  member: { active, role, teamIds: ["team"] },
});

for (const role of ["admin", "member"] as const) {
  test(`${role} has the same eligibility for prompts, delegation, GitHub and answers`, () => {
    for (const action of ["prompt", "delegate", "github", { kind: "answer" }] as const)
      expect(canAct(actor(role), action).allowed).toBe(true);
    expect(canAnswer({ kind: "agent" }, actor(role))).toBe(true);
    expect(canAnswer({ kind: "closeout-bypass" }, actor(role))).toBe(true);
    expect(isWorkspaceAdmin(role)).toBe(role === "admin");
  });
}

test("only admin is a workspace admin; the retired roles are not", () => {
  expect(["admin", "member", "owner", "observer"].filter(isWorkspaceAdmin)).toEqual(["admin"]);
});

test("a Linear guest is told they can't use Paws", () => {
  expect(
    canAct({ ...actor("member"), identity: { ...identity, guest: true } }, "delegate"),
  ).toEqual({
    allowed: false,
    reason: "Linear guests can't use Paws.",
  });
});

for (const [kind, change, allowed] of [
  ["active member", {}, true],
  ["inactive Linear member", { identity: { ...identity, active: false } }, false],
  ["Linear guest", { identity: { ...identity, guest: true } }, false],
  ["other team's member", { identity: { ...identity, teamIds: ["other"] } }, false],
  ["inactive Paws member", { member: { active: false, role: "member", teamIds: ["team"] } }, false],
  ["Paws member outside team", { member: { active: true, role: "member", teamIds: [] } }, false],
  ["different identity", { identity: { ...identity, userId: "other" } }, false],
  ["unknown actor", { id: "unknown" }, false],
  ["system actor", { id: "linear" }, false],
  ["empty actor", { id: " " }, false],
] satisfies [string, Partial<ActionActor>, boolean][]) {
  test(`${kind} eligibility agrees across actions`, () => {
    const user = { ...actor("member"), ...change };
    for (const action of ["prompt", "delegate", "github", { kind: "answer" }] as const)
      expect(canAct(user, action).allowed).toBe(allowed);
  });
}

test("a verified member without Paws sign-in can reply but must sign in before delegation or GitHub", () => {
  const user = { ...actor("member"), member: null };
  expect(canAct(user, "prompt")).toEqual({ allowed: true });
  expect(canAnswer({ kind: "agent" }, user)).toBe(true);
  expect(canAnswer({ kind: "closeout-bypass" }, user)).toBe(true);
  const intake = canAct(user, "delegate");
  expect(intake).toEqual({
    allowed: false,
    signIn: true,
    reason: "It waits until you sign in to Paws with your Linear account.",
  });
  expect(canAct(user, "github")).toEqual(intake);
});

test("restricted answers also honor actor eligibility", () => {
  const question = { kind: "visual-review", delegatorId: "human", leadId: null } as const;
  expect(canAnswer(question, actor("member"))).toBe(true);
  expect(canAnswer(question, actor("member", false))).toBe(false);
  expect(canAnswer({ ...question, delegatorId: "other" }, actor("member"))).toBe(false);
  expect(canAnswer({ kind: "github-auth", actorId: "human" }, actor("member", false))).toBe(false);
});
