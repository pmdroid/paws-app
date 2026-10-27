import { expect, test } from "bun:test";
import { answerer, canAnswer } from "./answerers";

const strangers = ["unknown", "linear", "", "  "];

test("nobody without a Linear identity answers any kind of question", () => {
  for (const id of strangers) {
    expect(answerer(id)).toBeNull();
    expect(canAnswer({ kind: "agent" }, { id })).toBe(false);
    expect(canAnswer({ kind: "closeout-help" }, { id })).toBe(false);
    expect(canAnswer({ kind: "visual-review", delegatorId: id, leadId: id }, { id })).toBe(false);
    expect(canAnswer({ kind: "github-auth", actorId: id }, { id })).toBe(false);
  }
});

test("any identified Linear user answers an agent question or a Closeout bypass", () => {
  expect(answerer("user-1")).toEqual({ id: "user-1" });
  expect(canAnswer({ kind: "agent" }, { id: "user-1" })).toBe(true);
  expect(canAnswer({ kind: "closeout-help" }, { id: "user-1" })).toBe(true);
});

test("only the delegator or the project lead answers a visual review", () => {
  const question = { kind: "visual-review", delegatorId: "delegator-1", leadId: "lead-1" } as const;
  expect(canAnswer(question, { id: "delegator-1" })).toBe(true);
  expect(canAnswer(question, { id: "lead-1" })).toBe(true);
  expect(canAnswer(question, { id: "someone-else" })).toBe(false);
  expect(
    canAnswer({ kind: "visual-review", delegatorId: null, leadId: null }, { id: "someone-else" }),
  ).toBe(false);
});

test("only the actor who started a GitHub sign-in answers it", () => {
  expect(canAnswer({ kind: "github-auth", actorId: "actor-1" }, { id: "actor-1" })).toBe(true);
  expect(canAnswer({ kind: "github-auth", actorId: "actor-1" }, { id: "delegator-1" })).toBe(false);
});
