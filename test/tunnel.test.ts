import { describe, expect, test } from "bun:test";
import { downTunnel, startNgrokTunnel, type SpawnFn } from "../src/linear";

describe("ngrok tunnel", () => {
  test("starts ngrok with the dev-domain url and reports the probe", async () => {
    const spawned: { args: string[]; env: Record<string, string | undefined> }[] = [];
    let killed = false;
    const spawn: SpawnFn = (command, args, options) => {
      spawned.push({ args: [command, ...args], env: options.env });
      return {
        kill() {
          killed = true;
        },
        exited: new Promise(() => {}),
      };
    };
    const tunnel = startNgrokTunnel({
      port: 8787,
      url: "https://demo.ngrok-free.app",
      authtoken: "token-1",
      spawn,
      probe: async (url) => url === "https://demo.ngrok-free.app",
    });
    await Bun.sleep(0);
    expect(tunnel.requested).toBe(true);
    expect(tunnel.isUp()).toBe(true);
    expect(spawned[0]?.args).toEqual([
      "ngrok",
      "http",
      "--url=https://demo.ngrok-free.app",
      "8787",
    ]);
    expect(spawned[0]?.env["NGROK_AUTHTOKEN"]).toBe("token-1");
    expect(spawned[0]?.args.join(" ")).not.toContain("token-1");
    tunnel.stop();
    expect(killed).toBe(true);
    expect(tunnel.isUp()).toBe(false);
    expect(downTunnel().requested).toBe(false);
  });

  test("a missing ngrok binary leaves the tunnel down", async () => {
    const tunnel = startNgrokTunnel({
      port: 8787,
      url: "https://demo.ngrok-free.app",
      authtoken: null,
      spawn: () => {
        throw new Error("spawn ngrok ENOENT");
      },
    });
    await tunnel.refresh();
    expect(tunnel.requested).toBe(true);
    expect(tunnel.isUp()).toBe(false);
  });
});
