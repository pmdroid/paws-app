import { expect, test } from "bun:test";
import { parseTranscript, transcriptRunId } from "./transcript";

test("the transcript page reads its run from the engine path", () => {
  expect(transcriptRunId("/status/runs/run_01-abc/transcript")).toBe("run_01-abc");
  expect(transcriptRunId("/status/runs/run_01-abc/transcript/")).toBe("run_01-abc");
  expect(transcriptRunId("/status/runs/../transcript")).toBeNull();
  expect(transcriptRunId("/status/runs/run_01-abc")).toBeNull();
});

test("the transcript page accepts only well-formed entries", () => {
  const entry = { at: "2026-10-19T10:00:00.000Z", kind: "tool" as const, text: "ls" };
  expect(parseTranscript([entry])).toEqual([entry]);
  expect(parseTranscript([{ ...entry, kind: "shell" }])).toBeNull();
  expect(parseTranscript([{ ...entry, text: 1 }])).toBeNull();
  expect(parseTranscript({ entries: [entry] })).toBeNull();
});
