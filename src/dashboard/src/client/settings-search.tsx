import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { routePath, type Route } from "./route";
import {
  searchSettings,
  settingsPageRoute,
  settingsQuery,
  settingsSearchPath,
  shownSettingsPage,
  type SettingsPage,
} from "./settings-pages";
import { typing } from "./shortcuts";
import { SidebarMenu, SidebarMenuLink } from "./ui/sidebar";

let refocus = false;

export function SettingsSubmenu({
  label,
  pages,
  route,
  onNavigate,
}: {
  label: string;
  pages: readonly { id: SettingsPage; name: string }[];
  route: Route;
  onNavigate?: () => void;
}) {
  const { search } = useLocation();
  const navigate = useNavigate();
  const field = useRef<HTMLInputElement>(null);
  const query = settingsQuery(search);
  const matches = query.trim() === "" ? null : searchSettings(query);
  const shown = matches ? pages.filter((page) => matches.some((m) => m.id === page.id)) : pages;
  const suffix = query === "" ? "" : `?q=${encodeURIComponent(query)}`;

  useEffect(() => {
    if (!refocus) return;
    refocus = false;
    field.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target) || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      field.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="mt-1 ml-4 space-y-1 border-l border-border pl-2">
      <input
        ref={field}
        type="search"
        aria-label="Search settings"
        placeholder="Search settings"
        autoComplete="off"
        spellCheck={false}
        value={query}
        data-settings-search=""
        onChange={(event) => {
          const next = settingsSearchPath(route, event.target.value);
          refocus = !next.startsWith(`/${route.view}`);
          void navigate(next, { replace: true });
        }}
        className="h-8 w-full rounded-base border border-border bg-background px-2 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-ring"
      />
      {matches?.length === 0 ? (
        <p role="status" className="px-2 py-1.5 text-[13px] text-muted-foreground">
          No settings match this search.
        </p>
      ) : (
        <SidebarMenu aria-label={label} className="gap-0.5">
          {shown.map((page) => (
            <li key={page.id}>
              <SidebarMenuLink
                to={`${routePath(settingsPageRoute(page.id))}${suffix}`}
                active={shownSettingsPage(route) === page.id}
                onClick={onNavigate}
                className="text-[13px]"
              >
                {page.name}
              </SidebarMenuLink>
            </li>
          ))}
        </SidebarMenu>
      )}
    </div>
  );
}

let scrolled = "";
let watcher: MutationObserver | null = null;

export function scrollToSettingsMatch(root: HTMLElement | null, key: string, query: string): void {
  watcher?.disconnect();
  watcher = null;
  const needle = query.trim().toLowerCase();
  if (!root || needle === "" || scrolled === key) return;
  const reveal = () => {
    const found = [...root.querySelectorAll<HTMLElement>("h2, h3, legend, summary, label")].find(
      (element) =>
        element.getClientRects().length > 0 &&
        (element.textContent ?? "").toLowerCase().includes(needle),
    );
    if (!found) return false;
    scrolled = key;
    watcher?.disconnect();
    watcher = null;
    found.scrollIntoView({ block: "center" });
    return true;
  };
  watcher = new MutationObserver(reveal);
  watcher.observe(root, { childList: true, subtree: true });
  requestAnimationFrame(reveal);
}
