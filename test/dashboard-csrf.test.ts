import { describe, expect, test } from "bun:test";
import { readCsrfToken } from "../src/web/src/client/csrf";
import { handleStatusRequest } from "../src/web/src/server/handler";
import { injectCsrf, processCsrfToken } from "../src/web/src/server/csrf";

describe("dashboard CSRF token", () => {
  test("the status page embeds the token and the client reads it back", async () => {
    const page = await handleStatusRequest(new Request("http://127.0.0.1/status"), {
      staticDir: null,
      csrfToken: "csrf-token",
    });
    const html = (await page?.text()) ?? "";
    expect(html).toContain('name="paws-csrf" content="csrf-token"');
    const root = {
      querySelector: (selector: string) =>
        selector === 'meta[name="paws-csrf"]'
          ? { getAttribute: (name: string) => (name === "content" ? "csrf-token" : null) }
          : null,
    };
    expect(readCsrfToken(root)).toBe("csrf-token");
    expect(readCsrfToken({ querySelector: () => null })).toBe("");
  });

  test("injectCsrf adds one meta tag and defaults to the process token", () => {
    const once = injectCsrf("<html><head></head></html>");
    expect(once).toContain(`content="${processCsrfToken()}"`);
    expect(injectCsrf(once, "other")).toBe(once);
  });

  test("the GitHub sign-in routes are gone", async () => {
    for (const [path, method] of [
      ["/api/auth/github", "GET"],
      ["/api/auth/github/device", "POST"],
    ] as const) {
      const response = await handleStatusRequest(
        new Request(`http://127.0.0.1${path}`, { method }),
        { csrfToken: "csrf-token" },
      );
      expect(response).toBeNull();
    }
  });
});
