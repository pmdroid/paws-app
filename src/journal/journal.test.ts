import { expect, test } from "bun:test";
import { journalCaught, journalItemId, journalRejection, setJournalSink } from "./index";

test("recovered failures write one journal line with operation, item and message", () => {
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    journalCaught(new Error("retry\nbaseline\rfailed"), "startCloseoutRound", "item-715");
    expect(lines).toEqual([
      "catch item=item-715 operation=startCloseoutRound error=retry baseline failed",
    ]);
  } finally {
    restore();
  }
});

test("expected optional-file failures and unscoped operations are explicit", () => {
  const lines: string[] = [];
  const write = (line: string) => lines.push(line);
  journalCaught(
    Object.assign(new Error("not found"), { code: "ENOENT" }),
    "read-cache",
    null,
    "optional file may be absent",
    write,
  );
  journalCaught("denied", "removeWorktree", "item-715", undefined, write);
  expect(lines).toEqual([
    "catch item=none operation=read-cache expected=optional file may be absent code=ENOENT error=not found",
    "catch item=item-715 operation=removeWorktree error=denied",
  ]);
});

test("diagnostics redact credentials, flatten control characters and bound messages", () => {
  const lines: string[] = [];
  journalCaught(
    new Error(
      "ghs_private https://user:password@example.com/a?token=private Bearer private\u001b\n" +
        "x".repeat(2_000),
    ),
    "fetch",
    "item-715",
    undefined,
    (line) => lines.push(line),
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain("private");
  expect(lines[0]).not.toContain("password");
  expect(lines[0]).not.toContain("\n");
  expect(lines[0]).not.toContain(String.fromCharCode(27));
  expect(lines[0]!.length).toBeLessThan(1_100);
});

test("an existing rejection handler receives the same error and keeps its return value", () => {
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  const error = new Error("unavailable");
  try {
    const handle = journalRejection(
      "runner.stop",
      (received: Error) => {
        expect(received).toBe(error);
        return "recovered";
      },
      "item-715",
    );
    expect(handle(error)).toBe("recovered");
    expect(lines).toEqual(["catch item=item-715 operation=runner.stop error=unavailable"]);
  } finally {
    restore();
  }
});

test("an unexpected file failure is not labeled as an expected absence", () => {
  const lines: string[] = [];
  journalCaught(
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
    "read-cache",
    "item-715",
    "optional file may be absent",
    (line) => lines.push(line),
  );
  expect(lines[0]).toContain("code=EACCES");
  expect(lines[0]).not.toContain("expected=");
});

test("job payload context uses only a string work-item id", () => {
  expect(journalItemId({ itemId: "item-715" })).toBe("item-715");
  for (const payload of [null, undefined, "item-715", 715, {}, { itemId: 715 }])
    expect(journalItemId(payload)).toBeNull();
});

test("process races are labeled only for expected operating-system errors", () => {
  const lines: string[] = [];
  for (const code of ["ENOENT", "ESRCH", "EACCES", "EIO"])
    journalCaught(
      Object.assign(new Error("process read failed"), { code }),
      "process.stat",
      null,
      "process may be absent or inaccessible",
      (line) => lines.push(line),
    );
  for (const line of lines.slice(0, 3))
    expect(line).toContain("expected=process may be absent or inaccessible");
  expect(lines[3]).not.toContain("expected=");
});
