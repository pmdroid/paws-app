import { expect, test } from "bun:test";
import { boundRunnerError, fitPrompt, SHORTENED_MARKER } from "./prompt-fit";

test("fitting shortens the longest context first and keeps the kept parts whole", () => {
  const fitted = fitPrompt(
    [
      { text: "description", keep: true },
      { text: "a".repeat(500) },
      { text: "b".repeat(100) },
      { text: "latest", keep: true },
    ],
    400,
  );
  expect(fitted.length).toBeLessThanOrEqual(400);
  expect(fitted.startsWith("description\n\naaa")).toBe(true);
  expect(fitted).toContain(`a\n${SHORTENED_MARKER}\n\n${"b".repeat(100)}\n\nlatest`);
});

test("fitting leaves a prompt within the limit untouched and never splits a surrogate pair", () => {
  expect(fitPrompt([{ text: "one" }, { text: "two", keep: true }], 100)).toBe("one\n\ntwo");
  const fitted = fitPrompt([{ text: "😀".repeat(100) }], 81);
  expect(fitted.length).toBeLessThanOrEqual(81);
  expect(fitted).toBe(`${"😀".repeat(13)}\n${SHORTENED_MARKER}`);
});

test("a runner error keeps its first 20 lines and counts the rest", () => {
  expect(boundRunnerError("one\ntwo")).toBe("one\ntwo");
  const text = Array.from({ length: 21 }, (_, line) => `line ${line}`).join("\n");
  expect(boundRunnerError(text).split("\n")).toEqual([
    ...text.split("\n").slice(0, 20),
    "[1 more line left out; the full text is in the run's transcript.]",
  ]);
});
