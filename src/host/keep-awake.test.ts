import { describe, expect, test } from "bun:test";
import { KeepAwake, keepAwakeCommand, type Spawn } from "./keep-awake";

function recorder(): {
  spawn: Spawn;
  calls: { command: string; args: string[] }[];
  kills: () => number;
} {
  const calls: { command: string; args: string[] }[] = [];
  let killed = 0;
  const spawn: Spawn = (command, args) => {
    calls.push({ command, args });
    return {
      kill: () => {
        killed += 1;
      },
    };
  };
  return { spawn, calls, kills: () => killed };
}

describe("keep-awake command", () => {
  test("uses caffeinate on macOS and systemd-inhibit on Linux", () => {
    expect(keepAwakeCommand("darwin", 4242)).toEqual({
      command: "caffeinate",
      args: ["-i", "-w", "4242"],
    });
    const linux = keepAwakeCommand("linux", 7);
    expect(linux?.command).toBe("systemd-inhibit");
    expect(linux?.args).toContain("--what=idle:sleep");
    expect(keepAwakeCommand("win32", 1)).toBeNull();
  });

  test("holds one assertion while a run is active and releases it after", () => {
    const recorded = recorder();
    const keep = new KeepAwake("darwin", 4242, recorded.spawn);
    keep.setRunActive(true);
    keep.setRunActive(true);
    expect(recorded.calls).toEqual([{ command: "caffeinate", args: ["-i", "-w", "4242"] }]);
    expect(keep.isHeld).toBe(true);
    keep.setRunActive(false);
    expect(recorded.kills()).toBe(1);
    expect(keep.isHeld).toBe(false);
  });
});
