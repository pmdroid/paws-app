import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { WORKSPACE_PAGES, setSettingsAdmin } from "./settings-pages";
import type { Route } from "./route";
import { Navigation } from "./shell";

afterEach(() => setSettingsAdmin(false));

function sidebar(
  admin: boolean,
  path: string,
  route: Route = { view: "workspace", page: "merging" },
) {
  setSettingsAdmin(admin);
  const document = new Window().document;
  document.body.innerHTML = renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Navigation route={route} counts={{}} />
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
    current: null,
    group: "Manage",
  });
  expect(links.slice(runners + 2, runners + 2 + WORKSPACE_PAGES.length)).toEqual(
    WORKSPACE_PAGES.map((page) => ({
      text: page.name,
      href: `/workspace/${page.id}`,
      current: page.id === "merging" ? "page" : null,
      group: "Workspace pages",
    })),
  );
  expect(links.at(-1)).toMatchObject({ text: "Settings", href: "/settings", current: null });
});

test("members see Settings and no Workspace entry", () => {
  const links = sidebar(false, "/settings");
  expect(links.map((link) => link.text)).not.toContain("Workspace");
  expect(links.at(-1)).toMatchObject({ text: "Settings", href: "/settings" });
});

test("the Workspace submenu is closed away from Workspace and opens on its first page", () => {
  const away = sidebar(true, "/runners", { view: "runners", id: null } as Route);
  expect(away.map((link) => link.group)).not.toContain("Workspace pages");
  expect(away.find((link) => link.text === "Workspace")?.href).toBe("/workspace");
  const first = sidebar(true, "/workspace", { view: "workspace" });
  expect(first.filter((link) => link.current === "page").map((link) => link.text)).toEqual([
    "Agents",
  ]);
});

test("members see no Workspace submenu on a workspace path", () => {
  const links = sidebar(false, "/workspace/merging");
  expect(links.map((link) => link.group)).not.toContain("Workspace pages");
});
