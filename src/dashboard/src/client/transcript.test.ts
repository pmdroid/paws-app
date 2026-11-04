import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { TranscriptEntry } from "../contract";
import { parseTranscript, TranscriptSessions, transcriptRunId } from "./transcript";

test("the transcript page reads its run from the engine path", () => {
  expect(transcriptRunId("/dashboard/runs/run_01-abc/transcript")).toBe("run_01-abc");
  expect(transcriptRunId("/dashboard/runs/run_01-abc/transcript/")).toBe("run_01-abc");
  expect(transcriptRunId("/dashboard/runs/../transcript")).toBeNull();
  expect(transcriptRunId("/dashboard/runs/run_01-abc")).toBeNull();
});

test("the transcript page accepts only well-formed entries", () => {
  const entry = { at: "2026-10-19T10:00:00.000Z", kind: "tool" as const, text: "ls", session: 1 };
  expect(parseTranscript([entry])).toEqual([entry]);
  expect(parseTranscript([{ ...entry, session: 0 }])).toBeNull();
  expect(parseTranscript([{ ...entry, kind: "shell" }])).toBeNull();
  expect(parseTranscript([{ ...entry, text: 1 }])).toBeNull();
  expect(parseTranscript({ entries: [entry] })).toBeNull();
});

test("the transcript page shows the latest session and keeps earlier ones behind a button", async () => {
  const window = new Window({ url: "http://127.0.0.1:8787/dashboard/runs/run_1/transcript" });
  const names = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event"];
  const saved = names.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const);
  for (const name of names)
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const entry = (session: number, text: string): TranscriptEntry => ({
      at: `2026-11-03T1${session}:00:00.000Z`,
      kind: "system",
      text,
      session,
    });
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);
    const root = createRoot(container as unknown as HTMLElement);
    await act(async () =>
      root.render(
        createElement(TranscriptSessions, {
          entries: [entry(1, "first"), entry(2, "second"), entry(3, "third")],
        }),
      ),
    );
    const headings = () =>
      [...container.querySelectorAll("h2")].map((heading) => heading.textContent ?? "");
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Earlier sessions (2)");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(headings()).toHaveLength(1);
    expect(headings()[0]).toStartWith("Session 3, started ");
    expect(container.textContent).not.toContain("first");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(headings().map((heading) => heading.split(",")[0])).toEqual([
      "Session 1",
      "Session 2",
      "Session 3",
    ]);
    const text = container.textContent ?? "";
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    expect(text.indexOf("second")).toBeLessThan(text.indexOf("third"));
    await act(async () => root.unmount());
  } finally {
    for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    await window.happyDOM.close();
  }
});
