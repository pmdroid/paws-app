import { expect, test } from "bun:test";
import { setJournalSink } from "../src/db";
import { startPaws } from "../src/index";
import { shutdownPaws, stopPawsComponents } from "../src/shutdown";
import { tempHome } from "./helpers";

for (const requestedCode of [0, 75]) {
  test(`composition logs a rejected server stop and exits ${requestedCode} after database close`, async () => {
    const paws = startPaws({ PAWS_HOME: tempHome(), PAWS_PORT: "0" });
    const stopServer = paws.server.stop.bind(paws.server);
    paws.server.stop = async (force) => {
      await stopServer(force);
      throw new Error("fake server stop rejected");
    };
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    const exits: number[] = [];
    try {
      await shutdownPaws(paws, requestedCode, (code) => exits.push(code));
      expect(exits).toEqual([requestedCode]);
      const shutdownLines = lines.filter((line) => line.startsWith("Paws shutdown failed"));
      expect(shutdownLines).toHaveLength(1);
      expect(shutdownLines[0]).toContain(
        "Paws shutdown failed at server: Error: fake server stop rejected",
      );
      expect(lines.filter((line) => !shutdownLines.includes(line))).toEqual([
        "catch item=none operation=index.startPaws.ready expected=shutdown interrupted startup error=Paws is stopping.",
      ]);
      expect(() => paws.db.query("SELECT 1").get()).toThrow();
    } finally {
      restore();
      paws.server.stop = stopServer;
    }
  });
}

test.each(["state flush", "database close"])(
  "%s failure logs the cause and exits 1",
  async (stage) => {
    const calls: string[] = [];
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    const exits: number[] = [];
    const action = (name: string) => () => {
      calls.push(name);
      if (stage === name) throw new Error("fake persistence failure");
    };
    try {
      await shutdownPaws(
        {
          stop: () =>
            stopPawsComponents({
              groups: [],
              flush: action("state flush"),
              close: action("database close"),
            }),
        },
        0,
        (code) => exits.push(code),
      );
      expect(calls).toEqual(["state flush", "database close"]);
      expect(exits).toEqual([1]);
      expect(lines[0]).toContain(
        `Paws shutdown failed at ${stage}: Error: fake persistence failure`,
      );
    } finally {
      restore();
    }
  },
);

test("hanging cleanup is bounded, names the component, and still flushes state", async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const exits: number[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    await shutdownPaws(
      {
        stop: () =>
          stopPawsComponents({
            groups: [
              [{ name: "runner", stop: () => new Promise(() => {}) }],
              [
                {
                  name: "workspace",
                  stop: () => {
                    calls.push("workspace");
                  },
                },
              ],
            ],
            flush: () => {
              calls.push("flush");
            },
            close: () => {
              calls.push("close");
            },
            waitMs: 10,
          }),
      },
      0,
      (code) => exits.push(code),
    );
    expect(exits).toEqual([0]);
    expect(calls).toEqual(["workspace", "flush", "close"]);
    expect(lines[0]).toContain("Paws shutdown failed at runner: Error: did not stop within 10ms");
  } finally {
    restore();
  }
});

test("an unclassified stop rejection logs the thrown value and exits 1", async () => {
  const lines: string[] = [];
  const exits: number[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    await shutdownPaws({ stop: () => Promise.reject("unknown stop failure") }, 0, (code) =>
      exits.push(code),
    );
    expect(exits).toEqual([1]);
    expect(lines).toEqual(["Paws shutdown failed at stop: unknown stop failure"]);
  } finally {
    restore();
  }
});

test("a stop failure whose stack lacks its message still logs the message", async () => {
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  const exits: number[] = [];
  const error = new Error("fake server stop rejected");
  error.stack = "Error\n    at <anonymous> (test/shutdown.test.ts:1:1)";
  try {
    await shutdownPaws(
      {
        stop: () =>
          stopPawsComponents({
            groups: [
              [
                {
                  name: "server",
                  stop: () => {
                    throw error;
                  },
                },
              ],
            ],
            flush: () => {},
            close: () => {},
          }),
      },
      0,
      (code) => exits.push(code),
    );
    expect(lines).toEqual([
      "Paws shutdown failed at server: Error: fake server stop rejected\n    at <anonymous> (test/shutdown.test.ts:1:1)",
    ]);
  } finally {
    restore();
  }
});
