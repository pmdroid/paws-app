import { memo, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  LayoutDashboard,
  GitBranch,
  Terminal,
  CircleHelp,
  ShieldCheck,
  GitMerge,
  MessagesSquare,
  Server,
  Bot,
  Plug,
  Users,
  UserRound,
  History,
  Menu,
  BookOpen,
} from "lucide-react";
import type { StatusSnapshot } from "../contract";
import { parseRoute, routeHref, type Route } from "./route";
import { NAVIGATION, PAGES } from "./navigation";
import { SETTINGS_PAGES } from "./settings-pages";
import { AppearanceControl, initializeAppearance } from "./appearance";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "./ui/sheet";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuLink,
} from "./ui/sidebar";

const ICONS = {
  overview: LayoutDashboard,
  epics: GitBranch,
  projects: GitBranch,
  runs: Terminal,
  questions: CircleHelp,
  verdicts: ShieldCheck,
  queue: GitMerge,
  sessions: MessagesSquare,
  runners: Server,
  agents: Bot,
  integrations: Plug,
  workspace: Users,
  account: UserRound,
  audit: History,
  decisions: BookOpen,
};
type ShellState = { route: Route; project: StatusSnapshot["project"] | null };
const ControllerRegions = memo(function ControllerRegions() {
  return (
    <>
      <div id="top" />
      <div id="banner" />
      <section id="linear-session-start" hidden aria-label="Start Linear session" />
      <main id="content" tabIndex={-1} className="min-w-0 space-y-8 focus:outline-none">
        <div id="page-content" />
        <section id="workspace-access" hidden aria-label="Workspace settings" />
        <div id="github-auth" hidden />
      </main>
    </>
  );
});

function Navigation({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  return (
    <nav aria-label="Main navigation">
      {NAVIGATION.map((group) => (
        <SidebarGroup key={group.label} aria-label={group.label}>
          <h2 className="px-3 text-xs font-bold">{group.label}</h2>
          <SidebarMenu>
            {group.views.map((view) => {
              const Icon = ICONS[view];
              return (
                <li key={view}>
                  <SidebarMenuLink
                    href={routeHref({ view, id: null } as Route)}
                    active={route.view === view}
                    onClick={onNavigate}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span>{PAGES[view].title}</span>
                  </SidebarMenuLink>
                </li>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      ))}
      <SidebarGroup aria-label="Settings">
        <h2 className="px-3 text-xs font-bold">Settings</h2>
        <SidebarMenu>
          {SETTINGS_PAGES.map((page) => {
            const Icon = ICONS[page.id];
            return (
              <li key={page.id}>
                <SidebarMenuLink
                  href={routeHref({ view: "settings", page: page.id })}
                  active={route.view === "settings" && (route.page ?? "agents") === page.id}
                  onClick={onNavigate}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span>{page.name}</span>
                </SidebarMenuLink>
              </li>
            );
          })}
        </SidebarMenu>
      </SidebarGroup>
    </nav>
  );
}

export function mountShell(): {
  update(state: ShellState): void;
  setAuthenticated(value: boolean): void;
} {
  initializeAppearance();
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Dashboard root is missing");
  let update = (_state: ShellState) => {};
  let authenticate = (_value: boolean) => {};
  function Shell() {
    const [state, setState] = useState<ShellState>({
      route: parseRoute(location.hash),
      project: null,
    });
    const route = state.route;
    const [authenticated, setAuthenticated] = useState(false);
    const [open, setOpen] = useState(false);
    const menu = useRef<HTMLButtonElement>(null);
    const navigating = useRef(false);
    update = setState;
    authenticate = (value) => {
      setAuthenticated(value);
      if (!value) setOpen(false);
    };
    useEffect(() => {
      const media = window.matchMedia("(min-width: 768px)");
      const close = () => {
        if (media.matches) {
          navigating.current = true;
          setOpen(false);
        }
      };
      media.addEventListener("change", close);
      const routeChanged = () => {
        navigating.current = true;
        setOpen(false);
      };
      window.addEventListener("hashchange", routeChanged);
      return () => {
        media.removeEventListener("change", close);
        window.removeEventListener("hashchange", routeChanged);
      };
    }, []);
    return (
      <div className="flex min-h-dvh bg-background text-foreground">
        <a
          href="#content"
          className="sr-only fixed left-4 top-4 z-50 rounded-base border-2 border-border bg-main p-3 text-main-foreground focus:not-sr-only"
          onClick={(event) => {
            event.preventDefault();
            document.querySelector<HTMLElement>("#content")?.focus();
          }}
        >
          Skip to content
        </a>
        {authenticated && (
          <Sidebar className="hidden md:block">
            <div className="sticky top-0 flex h-dvh min-h-0 flex-col">
              <SidebarHeader>
                <a href="#/" className="text-xl font-bold tracking-tight">
                  Paws
                </a>
              </SidebarHeader>
              <SidebarContent>
                <Navigation route={state.route} />
              </SidebarContent>
            </div>
          </Sidebar>
        )}
        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex min-h-20 flex-wrap items-center justify-between gap-3 border-b-2 border-border bg-secondary-background px-4 py-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              {authenticated && (
                <Sheet
                  open={open}
                  onOpenChange={(next) => {
                    navigating.current = false;
                    setOpen(next);
                  }}
                >
                  <SheetTrigger
                    render={
                      <Button
                        ref={menu}
                        type="button"
                        variant="neutral"
                        size="icon"
                        className="md:hidden"
                        aria-label="Open navigation"
                      />
                    }
                  >
                    <Menu className="size-4" aria-hidden="true" />
                  </SheetTrigger>
                  <SheetContent
                    side="left"
                    className="w-72 max-w-[calc(100%-2rem)] gap-0 bg-secondary-background p-0"
                    finalFocus={() =>
                      navigating.current
                        ? document.querySelector<HTMLElement>("#content")
                        : menu.current
                    }
                  >
                    <div className="shrink-0 border-b-2 border-border p-5 pr-14">
                      <SheetTitle>Paws navigation</SheetTitle>
                      <SheetDescription className="sr-only">Dashboard pages</SheetDescription>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
                      <Navigation
                        route={state.route}
                        onNavigate={() => {
                          navigating.current = true;
                          setOpen(false);
                        }}
                      />
                    </div>
                  </SheetContent>
                </Sheet>
              )}
              <span className="text-sm font-semibold">
                {authenticated
                  ? route.view === "settings"
                    ? SETTINGS_PAGES.find((page) => page.id === (route.page ?? "agents"))!.name
                    : PAGES[state.route.view].title
                  : "Paws"}
              </span>
            </div>
            <AppearanceControl />
          </header>
          <div
            className={
              authenticated
                ? "mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 pb-4 pt-3 sm:px-6 sm:pb-6 lg:px-8"
                : "mx-auto flex w-full max-w-xl flex-col gap-6 p-6"
            }
          >
            <ControllerRegions />
          </div>
        </div>
      </div>
    );
  }
  flushSync(() => createRoot(root).render(<Shell />));
  return {
    update(state) {
      flushSync(() => update(state));
    },
    setAuthenticated(value) {
      flushSync(() => authenticate(value));
    },
  };
}
