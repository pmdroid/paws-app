import { fixtureProvider, fullStatusFixture, withRuleResults } from "../../src/web/test/fixtures";
// Captures the run page's Repository rules at desktop and 390 px in light and dark: a pass, a probe
// failure, a rule waiting for approval, an approval and a bypass. Fails on horizontal scroll or
// page errors.
// Usage: bun run build:status && bun --no-env-file test/local/rule-results-browser.ts <evidence-directory>
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { handleStatusRequest } from "../../src/web";

const directory = resolve(process.argv[2] ?? "rule-results-evidence");
await mkdir(directory, { recursive: true });

const snapshot = withRuleResults(fullStatusFixture());
snapshot.source = "live";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "owner",
        role: "owner",
        csrfToken: "rule-results-fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Paws" }],
        user: { name: "Owner" },
      });
    return (
      (await handleStatusRequest(request, {
        provider: fixtureProvider(snapshot),
        csrfToken: "rule-results-fixture",
      })) ?? new Response(null, { status: 404 })
    );
  },
});

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const observations: Record<string, unknown>[] = [];
try {
  for (const width of [1440, 390])
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.emulateMedia({ colorScheme: scheme });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/status/issues/ENG-100`);
      const section = page.locator(".rules-section");
      await section.getByText("Repository rules").waitFor();
      for (const text of ["Passed", "Failed", "Waiting for approval", "Approved", "Bypassed"])
        await section.getByText(text, { exact: true }).first().waitFor();
      await section.getByRole("button", { name: "Approve", exact: true }).waitFor();
      await section.getByRole("button", { name: "Send back", exact: true }).waitFor();
      await section.getByText("applies closeout_rejected outside src/loop").waitFor();
      // A string expression, because this file type-checks without the DOM library.
      const overflow = Number(
        await page.evaluate(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ),
      );
      const name = `rule-results-${width}-${scheme}.png`;
      await section.screenshot({ path: join(directory, name) });
      observations.push({ name, width, scheme, overflow, errors });
      await page.close();
    }
} finally {
  await browser.close();
  server.stop(true);
}
await writeFile(
  join(directory, "rule-results-observations.json"),
  `${JSON.stringify(observations, null, 2)}\n`,
);
console.log(JSON.stringify(observations));
const failed = observations.filter(
  (entry) => (entry.overflow as number) > 0 || (entry.errors as string[]).length,
);
if (failed.length) {
  console.error("Horizontal overflow or page errors:", JSON.stringify(failed));
  process.exit(1);
}
