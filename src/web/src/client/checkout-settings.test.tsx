import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { themedMarkup } from "./theme";
import type { CheckoutSettings } from "../checkout-settings";
import {
  addCheckoutPath,
  checkoutChanged,
  checkoutPathProblem,
  checkoutSettingsBody,
  checkoutSettingsRequest,
  emptyCheckoutView,
  loadedCheckoutView,
  removeCheckoutPath,
  renderCheckoutSettings,
  setCheckoutHideFrom,
} from "./checkout-settings";
import { renderSettingsPage } from "./settings-pages";

function settings(): CheckoutSettings {
  return {
    label: "paws:full-checkout",
    repositories: [
      {
        repo: "pmdroid/paws-app",
        paths: [
          { path: "docs/archive/", hideFrom: "agent", usedBy: [] },
          { path: "test/fixtures/large/**", hideFrom: "checks", usedBy: [] },
          { path: "docs/", hideFrom: "agent", usedBy: ["links"] },
        ],
        files: { total: 2310, agent: 1842 },
      },
      { repo: "pmdroid/kyotoagent", paths: [] },
    ],
  };
}

function markup(html: string) {
  return renderToStaticMarkup(<>{themedMarkup(html)}</>);
}

describe("repository checkout section", () => {
  test("comes first on the Agents page", () => {
    const page = renderSettingsPage("agents");
    expect(page.indexOf('id="checkout-settings"')).toBeGreaterThan(-1);
    expect(page.indexOf('id="checkout-settings"')).toBeLessThan(
      page.indexOf('id="skill-settings"'),
    );
    expect(renderSettingsPage("merging")).not.toContain("checkout-settings");
  });

  test("renders a card per repository with its badge, rows and notes", () => {
    const html = renderCheckoutSettings(loadedCheckoutView(settings()));
    expect(html).toContain("<h2>Repository checkout</h2>");
    expect(html).toContain("<code>paws:full-checkout</code>");
    expect(html).toContain("<h3>pmdroid/paws-app</h3>");
    expect(html).toContain("Agent sees 1,842 of 2,310 files");
    expect(html).toContain("<h3>pmdroid/kyotoagent</h3>");
    expect(html).toContain("Nothing left out");
    expect(html).toContain('<span class="tag warn wrap">Used by check: links</span>');
    expect(html).toContain(
      "docs/ is read by the Closeout check <b>links</b>. It stays visible to checks while it is hidden from the agent only.",
    );
    expect(html).toContain('<option value="checks" selected>Hidden from agent and checks</option>');
    expect(html).toContain('aria-label="Remove docs/archive/"');
    expect(html).toContain('placeholder="docs/plans/  or  **/*.generated.ts"');
    expect(html).toContain("Add path");
    expect(html).toContain('data-checkout="save" disabled');
    expect(html).toContain('data-checkout="discard" disabled');
    const themed = markup(html);
    expect(themed).toContain("Agent sees 1,842 of 2,310 files");
    expect(themed).toContain("Hidden from the agent");
  });

  test("hiding a path a check reads from checks warns, and several checks are listed", () => {
    const view = loadedCheckoutView(settings());
    setCheckoutHideFrom(view, 0, 2, "checks");
    expect(renderCheckoutSettings(view)).toContain(
      '<p class="checkout-note warn" role="note">docs/ is read by the Closeout check <b>links</b>. Hiding it from checks can make that check fail.</p>',
    );
    view.draft[0]!.paths[2]!.usedBy = ["links", "types"];
    const several = renderCheckoutSettings(view);
    expect(several).toContain("Used by checks: links, types");
    expect(several).toContain(
      "docs/ is read by the Closeout checks <b>links</b>, <b>types</b>. Hiding it from checks can make those checks fail.",
    );
  });

  test("a badge counts paths when there are no file counts or the paths changed", () => {
    const data = settings();
    delete data.repositories[0]!.files;
    expect(renderCheckoutSettings(loadedCheckoutView(data))).toContain("3 paths left out");
    const view = loadedCheckoutView(settings());
    removeCheckoutPath(view, 0, 0);
    removeCheckoutPath(view, 0, 0);
    expect(renderCheckoutSettings(view)).toContain("1 path left out");
  });

  test("loading, failure and denied states", () => {
    expect(renderCheckoutSettings(emptyCheckoutView())).toContain("Loading repository checkout…");
    const failed = renderCheckoutSettings({ ...emptyCheckoutView(), error: "Engine is down." });
    expect(failed).toContain('role="alert">Engine is down.');
    expect(failed).toContain('data-checkout="reload"');
    expect(renderCheckoutSettings({ ...emptyCheckoutView(), denied: true })).toContain(
      "Only workspace owners and admins",
    );
  });

  test("validates a new path", () => {
    const existing = ["docs/"];
    expect(checkoutPathProblem("  ", existing)).toBe("Enter a path or glob.");
    expect(checkoutPathProblem("docs\\plans", existing)).toContain("forward slashes");
    expect(checkoutPathProblem("/etc/passwd", existing)).toContain("relative");
    expect(checkoutPathProblem("C:/temp", existing)).toContain("relative");
    expect(checkoutPathProblem("../secrets", existing)).toContain(`"." or ".."`);
    expect(checkoutPathProblem("docs/./plans", existing)).toContain(`"." or ".."`);
    expect(checkoutPathProblem(".git/", existing)).toContain(".git");
    expect(checkoutPathProblem("src/.git", existing)).toContain(".git");
    expect(checkoutPathProblem("docs//plans", existing)).toContain("empty part");
    expect(checkoutPathProblem("docs/plans//", existing)).toContain("empty part");
    expect(checkoutPathProblem(" docs/ ", existing)).toBe("This path is already listed.");
    expect(checkoutPathProblem("docs/plans/", existing)).toBeNull();
    expect(checkoutPathProblem("**/*.generated.ts", existing)).toBeNull();
    expect(checkoutPathProblem(".github/", existing)).toBeNull();
  });

  test("adding shows an inline error, or adds a trimmed row hidden from the agent", () => {
    const view = loadedCheckoutView(settings());
    expect(addCheckoutPath(view, 1, "../up")).toBe(false);
    const rejected = renderCheckoutSettings(view);
    expect(rejected).toContain('id="checkout-add-1-error" role="alert"');
    expect(rejected).toContain('value="../up"');
    expect(rejected).toContain('aria-invalid="true"');
    expect(checkoutChanged(view)).toBe(false);
    expect(addCheckoutPath(view, 1, "  docs/plans/ ")).toBe(true);
    expect(view.draft[1]!.paths).toEqual([{ path: "docs/plans/", hideFrom: "agent", usedBy: [] }]);
    const added = renderCheckoutSettings(view);
    expect(added).not.toContain("checkout-add-1-error");
    expect(added).toContain("1 path left out");
    expect(checkoutChanged(view)).toBe(true);
    expect(added).not.toContain('data-checkout="save" disabled');
  });

  test("changing where a path is hidden, or removing it, marks the page changed", () => {
    const view = loadedCheckoutView(settings());
    setCheckoutHideFrom(view, 0, 0, "checks");
    expect(checkoutChanged(view)).toBe(true);
    setCheckoutHideFrom(view, 0, 0, "agent");
    expect(checkoutChanged(view)).toBe(false);
    removeCheckoutPath(view, 0, 1);
    expect(checkoutChanged(view)).toBe(true);
    expect(renderCheckoutSettings(view)).toContain('data-checkout="discard" >');
  });

  test("saves every repository with the CSRF token and shows the response's warnings", async () => {
    const view = loadedCheckoutView(settings());
    setCheckoutHideFrom(view, 0, 2, "checks");
    const body = checkoutSettingsBody(view.draft);
    expect(body).toEqual({
      repositories: [
        {
          repo: "pmdroid/paws-app",
          paths: [
            { path: "docs/archive/", hideFrom: "agent" },
            { path: "test/fixtures/large/**", hideFrom: "checks" },
            { path: "docs/", hideFrom: "checks" },
          ],
        },
        { repo: "pmdroid/kyotoagent", paths: [] },
      ],
    });
    let sent: { url: string; init: RequestInit } | null = null;
    const warning = "docs/ is used by the Closeout check links and is hidden from checks.";
    const fake = (async (url: URL, init: RequestInit) => {
      sent = { url: String(url), init };
      return Response.json({ ...settings(), warnings: [warning] });
    }) as unknown as typeof fetch;
    const saved = await checkoutSettingsRequest("http://127.0.0.1:8787", "PUT", body, "csrf", fake);
    expect(sent!.url).toBe("http://127.0.0.1:8787/api/settings/checkout");
    expect(sent!.init.method).toBe("PUT");
    expect(JSON.parse(String(sent!.init.body))).toEqual(body);
    const headers = sent!.init.headers as Record<string, string>;
    expect(headers["x-paws-csrf"]).toBe("csrf");
    expect(headers["Content-Type"]).toBe("application/json");
    const after = { ...loadedCheckoutView(saved), notice: "Saved.", warnings: saved.warnings! };
    const html = renderCheckoutSettings(after);
    expect(html).toContain(`<div class="checkout-note warn" role="alert"><p>${warning}</p></div>`);
    expect(html).toContain('role="status">Saved.</p>');
  });

  test("a server error carries its message", async () => {
    const fake = (async () =>
      Response.json(
        { error: "Path docs/ is invalid." },
        { status: 400 },
      )) as unknown as typeof fetch;
    await expect(
      checkoutSettingsRequest("http://127.0.0.1:8787", "GET", undefined, "", fake),
    ).rejects.toThrow("Path docs/ is invalid.");
    const html = renderCheckoutSettings({
      ...loadedCheckoutView(settings()),
      error: "Path docs/ is invalid.",
    });
    expect(html).toContain(
      '<p class="settings-message err" role="alert">Path docs/ is invalid.</p>',
    );
  });
});
