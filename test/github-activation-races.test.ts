import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { authProvider, runnerRepositoryAccess } from "../src/index";
import { createGitHubInstallationCheck, type ActiveGitHubApp } from "../src/auth";
import { loadRuntime } from "../src/config";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const repository = {
  owner: "acme",
  repo: "widgets",
  remoteUrl: "https://github.com/acme/widgets.git",
};

for (const operation of ["token", "botIdentity", "runner", "installation"] as const) {
  test(`activated installation replacement fences held ${operation} and permits current generation`, async () => {
    let active: ActiveGitHubApp = {
      appId: "99",
      clientId: "client",
      clientSecret: "synthetic",
      privateKeyPem: key,
      installationId: "10",
      generation: 1,
    };
    const resolve = () => ({ ...active });
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let pause = true;
    const native = globalThis.fetch;
    const http = (async (input: Request | string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens")) {
        if (pause) {
          entered.resolve();
          await held.promise;
        }
        return Response.json(
          {
            token: "synthetic-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            repository_selection: "selected",
            repositories: [{ name: "widgets", full_name: "acme/widgets" }],
            permissions: {
              contents: "write",
              pull_requests: "write",
              checks: "write",
              issues: "write",
            },
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/app")
        return Response.json({ id: 99, slug: "paws-test", client_id: "client" });
      if (url.pathname.endsWith("/installation"))
        return Response.json({ id: Number(active.installationId), suspended_at: null });
      if (url.pathname.startsWith("/users/"))
        return Response.json({ id: 88, login: "paws-test[bot]", type: "Bot" });
      throw new Error(`Unexpected scripted request ${url.pathname}`);
    }) as typeof fetch;
    globalThis.fetch = http;
    try {
      const runtime = loadRuntime({ PAWS_HOME: "/tmp/synthetic-paws-unused", GITHUB_AUTH: "app" });
      const provider = authProvider(runtime, repository, "write", resolve)!;
      const runner = runnerRepositoryAccess(runtime, resolve)!;
      const check = createGitHubInstallationCheck({
        home: "/tmp/synthetic-paws-unused",
        env: {},
        resolve,
        fetch: http,
      });
      const invoke = () =>
        operation === "runner"
          ? runner.github.mintInstallationToken({
              repository: "acme/widgets",
              installationId: active.installationId!,
              access: "write",
            })
          : operation === "installation"
            ? check("acme/widgets", "write", new AbortController().signal)
            : provider[operation]!();
      const pending = invoke();
      await entered.promise;
      active = { ...active, installationId: "11", generation: 2 };
      held.resolve();
      if (operation === "installation") expect(await pending).toBe(false);
      else await expect(pending).rejects.toThrow("replaced");
      pause = false;
      const result = await invoke();
      expect(result).toBeTruthy();
    } finally {
      globalThis.fetch = native;
      held.resolve();
    }
  });
}
