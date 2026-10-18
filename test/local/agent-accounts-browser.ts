import { chromium } from "@playwright/test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { demoStatus } from "../../src/web/src/demo";
const root = resolve(import.meta.dir, "../..");
const output = mkdtempSync(join(tmpdir(), "paws-agent-accounts-browser-"));
const calls: {
  method: string;
  path: string;
  body: { accept?: boolean; text?: string } | null;
  csrf: string | null;
}[] = [];
const sessions: Record<
  string,
  {
    id?: string;
    agent?: string;
    state: string;
    expiresAt?: number;
    terminal?: string;
    authorization?: { url: string; message: string } | null;
  }
> = {};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const asset = url.pathname.replace(/^\/(status\/)?assets\//, "");
    if (asset !== url.pathname && !asset.includes("/"))
      return new Response(Bun.file(`${root}/src/web/dist/assets/${asset}`));
    if (url.pathname === "/status/" || url.pathname === "/")
      return new Response(
        (await Bun.file(`${root}/src/web/dist/index.html`).text()).replace(
          "</head>",
          '<meta name="paws-csrf" content="synthetic-csrf"></head>',
        ),
        { headers: { "content-type": "text/html" } },
      );
    if (url.pathname.endsWith("/config.json")) return Response.json({ engineUrl: url.origin });
    if (url.pathname === "/api/auth/session")
      return Response.json({
        userId: "person",
        user: { name: "Member", email: "member@example.test" },
        role: "member",
        workspaceId: "workspace",
        csrfToken: "synthetic-csrf",
        authenticatedAt: Date.now(),
        workspaces: [{ id: "workspace", name: "Team workspace", role: "member" }],
      });
    if (url.pathname === "/api/status") return Response.json({ ...demoStatus(), source: "live" });
    const match = url.pathname.match(
      /^\/api\/runners\/runner-a\/accounts\/(claude|codex)\/login(?:\/([^/]+))?(\/input)?$/,
    );
    if (url.pathname === "/api/runners")
      return Response.json({
        runners: [{ id: "runner-a", name: "Team Linux runner", status: "active" }],
        workspaceReady: true,
      });
    if (url.pathname === "/api/runners/usage") return Response.json({ usage: [] });
    if (url.pathname === "/api/runners/runner-a/policy")
      return Response.json({ ownerUserId: "person", sharing: 0 });
    if (url.pathname === "/api/runners/runner-a/accounts")
      return Response.json({
        accounts: ["claude", "codex"].map((agent) => ({
          agent,
          connected: sessions[agent]?.state === "connected",
          updatedAt: null,
          session: sessions[agent] ?? null,
        })),
      });
    if (!match) return Response.json({ error: "Not found" }, { status: 404 });
    const agent = match[1]!;
    const body =
      req.method === "POST" ? ((await req.json()) as { accept?: boolean; text?: string }) : null;
    calls.push({
      method: req.method,
      path: url.pathname,
      body,
      csrf: req.headers.get("x-paws-csrf"),
    });
    if (req.method !== "GET" && req.headers.get("x-paws-csrf") !== "synthetic-csrf")
      return Response.json({ error: "CSRF" }, { status: 403 });
    if (req.method === "POST" && !match[2])
      sessions[agent] = {
        id: `${agent}-session`,
        agent,
        state: "waiting",
        expiresAt: Date.now() + 120000,
        terminal: agent === "claude" ? "Paste your authorization code:" : "",
        authorization:
          agent === "codex"
            ? { url: "https://auth.openai.com/codex/device", message: "Enter code TEST-1234" }
            : null,
      };
    else if (req.method === "DELETE") sessions[agent] = { ...sessions[agent], state: "cancelled" };
    else if (match[3])
      sessions[agent] = {
        ...sessions[agent],
        state: "connected",
        authorization: null,
        terminal: "",
      };
    return Response.json(sessions[agent]);
  },
});
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let providerRequests = 0;
  await context.route("https://auth.openai.com/**", (route) => {
    providerRequests++;
    return route.fulfill({ body: "Synthetic provider login" });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.port}/status/#/runners`);
  await page.getByRole("button", { name: "Sign in to agents", exact: true }).click();
  await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
  await page.getByRole("link", { name: "Open Codex sign-in", exact: true }).waitFor();
  if (providerRequests !== 0) throw new Error("Provider fetched before acceptance");
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  if (
    await page.evaluate(() => {
      const window = globalThis as unknown as {
        document: { documentElement: { scrollWidth: number } };
        innerWidth: number;
      };
      return window.document.documentElement.scrollWidth > window.innerWidth;
    })
  )
    throw new Error("Mobile overflow");
  await page.getByRole("link", { name: "Open Codex sign-in", exact: true }).click();
  await page
    .locator('[data-agent="codex"] [data-agent-status]')
    .filter({ hasText: "Connected to your account" })
    .waitFor();
  await page.getByRole("button", { name: "Sign in to Claude", exact: true }).click();
  await page.getByLabel("Reply to Claude").fill("synthetic-code");
  await page.waitForTimeout(2300);
  if ((await page.getByLabel("Reply to Claude").inputValue()) !== "synthetic-code")
    throw new Error("Polling erased input");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await page
    .locator('[data-agent="claude"] [data-agent-status]')
    .filter({ hasText: "Connected to your account" })
    .waitFor();
  await page.getByRole("button", { name: "Sign in to Claude", exact: true }).click();
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await page.locator('[data-agent="claude"] [data-agent-terminal]').waitFor({ state: "hidden" });
  await page
    .locator('[data-agent="claude"] [data-agent-status]')
    .filter({ hasText: "Sign-in cancelled" })
    .waitFor();
  await page.screenshot({ path: `${output}/cancelled.png`, fullPage: true });
  if (errors.length) throw new Error(errors.join("\n"));
  if (
    !calls.some((c) => c.body?.accept === true) ||
    !calls.some((c) => c.body?.text === "synthetic-code\r")
  )
    throw new Error("Missing provider confirmation");
  writeFileSync(
    `${output}/observations.json`,
    JSON.stringify({ passed: true, providerRequests, calls, errors }, null, 2),
  );
  console.log(`VERIFIED ${output}`);
} finally {
  await browser.close();
  server.stop(true);
}
