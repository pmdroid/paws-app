import { expect, test } from "bun:test";
import { handleUnhandledRejection } from "./unhandled";

test("a request timeout or abort is journalled and Paws keeps running", () => {
  for (const error of [
    new DOMException("The operation timed out.", "TimeoutError"),
    new DOMException("This operation was aborted", "AbortError"),
  ]) {
    const journalled: unknown[] = [];
    let exited: number | null = null;
    handleUnhandledRejection(error, {
      journal: (caught) => journalled.push(caught),
      exit: (code) => {
        exited = code;
      },
    });
    expect(journalled).toEqual([error]);
    expect(exited as number | null).toBeNull();
  }
});

test("any other unhandled rejection still exits", () => {
  const journalled: unknown[] = [];
  let exited: number | null = null;
  handleUnhandledRejection(new Error("broken invariant"), {
    journal: (caught) => journalled.push(caught),
    exit: (code) => {
      exited = code;
    },
  });
  expect(journalled).toHaveLength(1);
  expect(exited as number | null).toBe(1);
});
