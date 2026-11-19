import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { settingsPageShown } from "./settings-loads";
import { initializeWorkspaceSlack } from "./workspace-slack";
import { initializeWorkspaceSlackLink } from "./workspace-slack-link";

async function withDom(
  page: "account" | "integrations",
  respond: (method: string, url: string) => unknown,
  run: (root: HTMLElement, requests: string[]) => Promise<void>,
) {
  const window = new Window({ url: "https://paws.example/dashboard/workspace" });
  const globals = globalThis as Record<string, unknown>;
  const names = ["window", "document", "location", "history", "HTMLElement"];
  const saved = names.map((name) => globals[name]);
  for (const name of names)
    globals[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  const requests: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    return Response.json(respond(method, url));
  }) as typeof fetch;
  try {
    const root = window.document.createElement("div") as unknown as HTMLElement;
    if (page === "account") initializeWorkspaceSlackLink(root, "csrf");
    else initializeWorkspaceSlack(root, "csrf");
    settingsPageShown(page);
    await Bun.sleep(20);
    await run(root, requests);
  } finally {
    globalThis.fetch = realFetch;
    names.forEach((name, index) => (globals[name] = saved[index]));
    settingsPageShown(null);
    await window.happyDOM.close();
  }
}

test("a member sees their own Slack link and unlinks it", async () => {
  let linked = true;
  await withDom(
    "account",
    (method) => {
      if (method === "DELETE") linked = false;
      const link = { teamId: "T1", channelId: "C1", slackUserId: "U1" };
      return method === "DELETE" ? { removed: 1 } : { connected: true, link: linked ? link : null };
    },
    async (root, requests) => {
      expect(root.querySelector("[data-slack-link]")?.textContent).toContain("U1");
      root.querySelector<HTMLButtonElement>("[data-slack-unlink]")!.click();
      await Bun.sleep(20);
      expect(requests).toContain("DELETE /api/workspaces/slack/link");
      expect(root.querySelector("[data-slack-link]")?.textContent).toContain("Not linked");
      expect(root.querySelector("[data-slack-unlink]")).toBeNull();
    },
  );
});

test("an admin sees linked members on the Slack card and revokes one", async () => {
  await withDom(
    "integrations",
    (method, url) =>
      url.startsWith("/api/workspaces/slack/links")
        ? method === "DELETE"
          ? { removed: 1 }
          : {
              links: [
                { slackUserId: "U2", channelId: "C1", userId: "u2", name: "Ada", active: false },
              ],
            }
        : {
            configured: true,
            connection: { teamId: "T1", teamName: "Acme", appId: "A1", botUserId: "B1" },
            capabilities: null,
          },
    async (root, requests) => {
      expect(root.querySelector('[data-slack-link="U2"]')?.textContent).toContain(
        "Ada as U2 in C1 (Paws access revoked)",
      );
      root.querySelector<HTMLButtonElement>('[data-slack-revoke="U2"]')!.click();
      await Bun.sleep(20);
      expect(requests).toContain("DELETE /api/workspaces/slack/links?user=U2");
      expect(root.querySelector("[data-slack-notice]")?.textContent).toContain("Revoked");
    },
  );
});
