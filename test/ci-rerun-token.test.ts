import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { authProvider, gitHostToken } from "../src/index";
import type { ActiveGitHubApp } from "../src/auth";
import { loadRuntime } from "../src/config";
import { createFetchGitHubClient, rerunFailedCi } from "../src/github";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const head = "abc1234def5678abc1234def5678abc1234def56";

test("the merge lane and rerun_ci re-run CI with the App's Actions write token", async () => {
  const active: ActiveGitHubApp = {
    appId: "99",
    clientId: "client",
    clientSecret: "synthetic",
    privateKeyPem: key,
    installationId: "10",
    generation: 1,
  };
  const requested: Record<string, string>[] = [];
  const http = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/app/installations/10/access_tokens") {
      const { permissions } = JSON.parse(String(init?.body)) as {
        permissions: Record<string, string>;
      };
      requested.push(permissions);
      return Response.json(
        {
          token:
            permissions.actions === "write" ? "synthetic-actions-token" : "synthetic-push-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          repository_selection: "selected",
          repositories: [{ name: "widgets", full_name: "acme/widgets" }],
          permissions,
        },
        { status: 201 },
      );
    }
    if (method === "GET" && url.pathname === "/repos/acme/widgets/pulls/5")
      return Response.json({ state: "open", head: { sha: head } });
    if (method === "GET" && url.pathname === `/repos/acme/widgets/commits/${head}/check-runs`)
      return Response.json({
        check_runs: [
          {
            name: "test",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-11-10T16:00:00Z",
            completed_at: "2026-11-10T16:01:00Z",
            html_url: "https://github.com/acme/widgets/actions/runs/77/job/1",
            app: { slug: "github-actions" },
          },
        ],
      });
    if (
      method === "POST" &&
      url.pathname === "/repos/acme/widgets/actions/runs/77/rerun-failed-jobs"
    )
      return new Headers(init?.headers).get("authorization") === "Bearer synthetic-actions-token"
        ? new Response(null, { status: 201 })
        : Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    throw new Error(`Unexpected scripted request ${method} ${url.pathname}`);
  }) as typeof fetch;
  const native = globalThis.fetch;
  globalThis.fetch = http;
  try {
    const runtime = loadRuntime({ PAWS_HOME: "/tmp/synthetic-paws-unused", GITHUB_AUTH: "app" });
    const repository = {
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
    };
    const result = await rerunFailedCi({
      client: createFetchGitHubClient(http),
      owner: "acme",
      repo: "widgets",
      prNumber: 5,
      alreadyRerun: async () => false,
      tokenProvider: gitHostToken(authProvider(runtime, repository, "write", async () => active)!),
    });
    expect(result.rerun).toEqual({ head, runIds: [77] });
    expect(requested.at(-1)).toEqual({ actions: "write", contents: "read", metadata: "read" });
  } finally {
    globalThis.fetch = native;
  }
});
