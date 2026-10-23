import { expect, test } from "bun:test";
import { parseVisualReviewAnswer } from "./visual-review";

test("Accept and its variants accept the screens", () => {
  for (const answer of ["Accept", " accept ", "Accepted.", "approve", "Approved!"])
    expect(parseVisualReviewAnswer(answer)).toEqual({ kind: "accept" });
});

test("any other reply is the feedback, without a leading Request changes", () => {
  expect(parseVisualReviewAnswer("Make the hint shorter")).toEqual({
    kind: "changes",
    feedback: "Make the hint shorter",
  });
  expect(parseVisualReviewAnswer("Request changes: make the hint shorter")).toEqual({
    kind: "changes",
    feedback: "make the hint shorter",
  });
  expect(parseVisualReviewAnswer("Accept the colors but move the button")).toEqual({
    kind: "changes",
    feedback: "Accept the colors but move the button",
  });
});

test("Request changes alone asks which changes", () => {
  expect(parseVisualReviewAnswer("Request changes")).toEqual({ kind: "describe" });
  expect(parseVisualReviewAnswer("request changes.")).toEqual({ kind: "describe" });
});
