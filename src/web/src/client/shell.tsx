import { memo, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  createBrowserRouter,
  Link,
  RouterProvider,
  useLocation,
  type DataRouter,
} from "react-router";
import {
  LayoutDashboard,
  GitBranch,
  ListTodo,
  Terminal,
  CircleHelp,
  Server,
  Bot,
  Plug,
  Users,
  UserRound,
  History,
  Menu,
  BookOpen,
  GitMerge,
  GitPullRequestArrow,
} from "lucide-react";
import { parseRoute, routePath, routerBase, type Route } from "./route";
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
  issues: ListTodo,
  projects: GitBranch,
  runs: Terminal,
  mergeQueue: GitPullRequestArrow,
  questions: CircleHelp,
  runners: Server,
  agents: Bot,
  merging: GitMerge,
  integrations: Plug,
  workspace: Users,
  account: UserRound,
  audit: History,
  decisions: BookOpen,
};
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

/** Pages whose entry carries a count, such as the tasks waiting to merge. */
export type NavigationCounts = Partial<Record<Route["view"], number>>;

function Navigation({
  route,
  counts,
  onNavigate,
}: {
  route: Route;
  counts: NavigationCounts;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Main navigation">
      {NAVIGATION.map((group) => (
        <SidebarGroup key={group.label} aria-label={group.label}>
          <h2 className="px-3 text-xs font-bold">{group.label}</h2>
          <SidebarMenu>
            {group.views.map((view) => {
              const Icon = ICONS[view];
              const count = counts[view] ?? 0;
              return (
                <li key={view}>
                  <SidebarMenuLink
                    to={routePath({ view, id: null } as Route)}
                    active={route.view === view}
                    onClick={onNavigate}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span>{PAGES[view].title}</span>
                    {count > 0 && (
                      <span
                        className="ml-auto rounded-base border-2 border-border bg-secondary-background px-1.5 text-xs font-bold leading-5 text-foreground"
                        aria-label={`${count} waiting`}
                      >
                        {count}
                      </span>
                    )}
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
                  to={routePath({ view: "settings", page: page.id })}
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
  router: DataRouter;
  setAuthenticated(value: boolean): void;
  setBreadcrumb(value: { issueId: string | null; entityId: string } | null): void;
  setCounts(value: NavigationCounts): void;
} {
  initializeAppearance();
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Dashboard root is missing");
  let authenticate = (_value: boolean) => {};
  let breadcrumb = (_value: { issueId: string | null; entityId: string } | null) => {};
  let counted = (_value: NavigationCounts) => {};
  function Shell() {
    const { pathname } = useLocation();
    const route = parseRoute(pathname);
    const [authenticated, setAuthenticated] = useState(false);
    const [detail, setDetail] = useState<{ issueId: string | null; entityId: string } | null>(null);
    breadcrumb = (value) => setDetail(value);
    const [counts, setCounts] = useState<NavigationCounts>({});
    counted = (value) =>
      setCounts((current) =>
        Object.keys({ ...current, ...value }).every(
          (key) => current[key as Route["view"]] === value[key as Route["view"]],
        )
          ? current
          : value,
      );
    const [open, setOpen] = useState(false);
    const menu = useRef<HTMLButtonElement>(null);
    const navigating = useRef(false);
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
      return () => media.removeEventListener("change", close);
    }, []);
    useEffect(() => {
      navigating.current = true;
      setOpen(false);
    }, [pathname]);
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
                <Link to="/" className="text-xl font-bold tracking-tight">
                  Paws
                </Link>
              </SidebarHeader>
              <SidebarContent>
                <Navigation route={route} counts={counts} />
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
                        route={route}
                        counts={counts}
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
                {authenticated && detail && (route.view === "runs" || route.view === "issues") ? (
                  <Link
                    to={routePath({ view: route.view, id: null })}
                    className="underline underline-offset-4"
                  >
                    {PAGES[route.view].title}
                  </Link>
                ) : authenticated ? (
                  route.view === "settings" ? (
                    SETTINGS_PAGES.find((page) => page.id === (route.page ?? "agents"))!.name
                  ) : (
                    PAGES[route.view].title
                  )
                ) : (
                  "Paws"
                )}
                {authenticated && detail && (
                  <>
                    <span className="mx-2">/</span>
                    {detail.issueId && (
                      <>
                        <Link
                          to={routePath({ view: "issues", id: detail.issueId })}
                          className="underline underline-offset-4"
                        >
                          {detail.issueId}
                        </Link>
                        <span className="mx-2">/</span>
                      </>
                    )}
                    <span className="font-mono text-xs">{detail.entityId}</span>
                  </>
                )}
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
  const router = createBrowserRouter([{ path: "*", element: <Shell /> }], {
    basename: routerBase(location.pathname) || "/",
  });
  flushSync(() => createRoot(root).render(<RouterProvider router={router} />));
  return {
    router,
    setBreadcrumb(value) {
      flushSync(() => breadcrumb(value));
    },
    setCounts(value) {
      flushSync(() => counted(value));
    },
    setAuthenticated(value) {
      flushSync(() => authenticate(value));
    },
  };
}
