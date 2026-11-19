import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { readExeDevToken, readTailscaleAuthKey } from "../src/config";
import { handleRunnerVmKeysSettingsRequest } from "../src/settings";
import { tempHome } from "./helpers";

const url = "http://127.0.0.1:8787/api/settings/runner-vm-keys";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function instance() {
  const home = tempHome();
  homes.push(home);
  const audits: string[] = [];
  const call = async (request: Request, role = "admin") =>
    (await handleRunnerVmKeysSettingsRequest(request, {
      home,
      csrfToken: "csrf",
      role,
      audit: async (action, subject) => {
        audits.push(`${action}: ${subject}`);
      },
    }))!;
  return { home, audits, call };
}

const headers = { "content-type": "application/json", "x-paws-csrf": "csrf" };
const put = (body: unknown) =>
  new Request(url, { method: "PUT", headers, body: JSON.stringify(body) });
const clear = (key: string) => new Request(`${url}?key=${key}`, { method: "DELETE", headers });

test("PUT then GET shows both keys set, and the readers see the saved values", async () => {
  const { home, audits, call } = instance();
  expect(await (await call(new Request(url))).json()).toEqual({ exeDev: false, tailscale: false });
  const saved = await call(put({ exeDev: " exe-token-1 ", tailscale: "tskey-auth-1" }));
  expect(saved.status).toBe(200);
  const text = await saved.text();
  expect(text).not.toContain("exe-token-1");
  expect(text).not.toContain("tskey-auth-1");
  expect(await (await call(new Request(url))).json()).toEqual({ exeDev: true, tailscale: true });
  expect(readExeDevToken(home)).toBe("exe-token-1");
  expect(readTailscaleAuthKey(home)).toBe("tskey-auth-1");
  expect(audits).toEqual([
    "settings.runner_vm_keys: Saved the exe.dev API token",
    "settings.runner_vm_keys: Saved the Tailscale auth key",
  ]);
  expect(audits.join("")).not.toContain("tskey");
});

test("DELETE clears one key and leaves the other", async () => {
  const { home, call } = instance();
  await call(put({ exeDev: "exe-token-1", tailscale: "tskey-auth-1" }));
  const cleared = await call(clear("tailscale"));
  expect(await cleared.json()).toEqual({ exeDev: true, tailscale: false });
  expect(readTailscaleAuthKey(home)).toBeNull();
  expect(readExeDevToken(home)).toBe("exe-token-1");
  expect((await call(clear("other"))).status).toBe(400);
});

test("members, a missing CSRF token and a spaced key are refused", async () => {
  const { home, call } = instance();
  expect((await call(new Request(url), "member")).status).toBe(403);
  expect((await call(put({ exeDev: "exe-token-1" }), "member")).status).toBe(403);
  expect((await call(clear("exeDev"), "member")).status).toBe(403);
  const noCsrf = new Request(url, { method: "PUT", body: JSON.stringify({ exeDev: "a" }) });
  expect((await call(noCsrf)).status).toBe(403);
  expect((await call(put({ tailscale: "two words" }))).status).toBe(400);
  expect(readExeDevToken(home)).toBeNull();
});
