import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { setSettingsAdmin } from "./settings-pages";
import { Navigation } from "./shell";

afterEach(() => setSettingsAdmin(false));

function sidebar(admin: boolean, path: string) {
  setSettingsAdmin(admin);
  const document = new Window().document;
  document.body.innerHTML = renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Navigation route={{ view: "workspace", page: "merging" }} counts={{}} />
    </MemoryRouter>,
  );
  return [...document.querySelectorAll("a")].map((link) => ({
    text: link.textContent,
    href: link.getAttribute("href"),
    current: link.getAttribute("aria-current"),
    group: link.closest("[aria-label]")?.getAttribute("aria-label"),
  }));
}

test("admins see Workspace under Manage below Runners, and Settings for everyone", () => {
  const links = sidebar(true, "/workspace/merging");
  const runners = links.findIndex((link) => link.text === "Runners");
  expect(links[runners + 1]).toEqual({
    text: "Workspace",
    href: "/workspace",
    current: "page",
    group: "Manage",
  });
  expect(links.at(-1)).toMatchObject({ text: "Settings", href: "/settings", current: null });
});

test("members see Settings and no Workspace entry", () => {
  const links = sidebar(false, "/settings");
  expect(links.map((link) => link.text)).not.toContain("Workspace");
  expect(links.at(-1)).toMatchObject({ text: "Settings", href: "/settings" });
});
