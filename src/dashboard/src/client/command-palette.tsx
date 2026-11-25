import { Dialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import {
  ISSUES_API_PATH,
  MERGE_QUEUE_API_PATH,
  parseIssueListResponse,
  parseMergeQueueResponse,
  type IssueListItem,
  type MergeQueueResponse,
} from "../contract";
import { journalCaught } from "../journal";
import { itemLabel } from "./format";
import { NAVIGATION, PAGES } from "./navigation";
import { routePath, type Route } from "./route";
import {
  USER_SETTINGS_PAGES,
  WORKSPACE_PAGES,
  settingsAreEditable,
  settingsPageRoute,
} from "./settings-pages";
import { Button } from "./ui/button";
import { cn } from "./ui/utils";

export type PaletteGroup = "Pages" | "Settings" | "Issues" | "PRs";

export type PaletteItem = {
  group: PaletteGroup;
  title: string;
  path: string;
  issue: string | null;
  detail?: string;
};

export type PaletteData = { issues: IssueListItem[]; queue: MergeQueueResponse | null };

const ISSUE_ID = /^[a-z]+-\d+$/i;
const GROUP_LIMIT = 8;

const VIEW_ITEMS: PaletteItem[] = NAVIGATION.flatMap((group) => group.views).map((view) => ({
  group: "Pages",
  title: PAGES[view].title,
  path: routePath({ view, id: null } as Route),
  issue: null,
}));

function settingsItems(needle: string): PaletteItem[] {
  return [...USER_SETTINGS_PAGES, ...(settingsAreEditable() ? WORKSPACE_PAGES : [])]
    .map((page) => {
      const route = settingsPageRoute(page.id);
      const title = `${PAGES[route.view].title} · ${page.name}`;
      const item: PaletteItem = { group: "Settings", title, path: routePath(route), issue: null };
      return { item, text: `${title} ${page.description}` };
    })
    .filter(({ text }) => text.toLowerCase().includes(needle))
    .map(({ item }) => item);
}

const matches = (needle: string, fields: Array<string | number | null | undefined>) =>
  fields.some((field) => field != null && String(field).toLowerCase().includes(needle));

function issueItems(needle: string, issues: IssueListItem[]): PaletteItem[] {
  return issues
    .filter((issue) =>
      matches(needle, [
        issue.id,
        issue.title,
        issue.state,
        itemLabel(issue.state),
        issue.project?.name,
      ]),
    )
    .slice(0, GROUP_LIMIT)
    .map((issue) => ({
      group: "Issues",
      title: issue.title,
      path: routePath({ view: "issues", id: issue.id }),
      issue: issue.id,
      detail: itemLabel(issue.state),
    }));
}

function pullItems(needle: string, queue: MergeQueueResponse | null): PaletteItem[] {
  if (!queue) return [];
  const repository = (id: string) =>
    [...queue.entries, ...queue.history].find((entry) => entry.itemId === id)?.repository ?? null;
  return queue.issues
    .flatMap((issue) => (issue.pr ? [{ issue, pr: issue.pr, repo: repository(issue.id) }] : []))
    .filter(({ issue, pr, repo }) =>
      matches(needle.replace(/^#/, ""), [
        issue.id,
        issue.title,
        pr.number,
        pr.title,
        pr.head,
        pr.state,
        repo,
      ]),
    )
    .slice(0, GROUP_LIMIT)
    .map(({ issue, pr, repo }) => ({
      group: "PRs",
      title: `#${pr.number} ${pr.title ?? issue.title}`,
      path: routePath({ view: "issues", id: issue.id }),
      issue: issue.id,
      detail: [repo, pr.head].filter(Boolean).join(" · "),
    }));
}

export function paletteItems(
  query: string,
  data: PaletteData = { issues: [], queue: null },
): PaletteItem[] {
  const text = query.trim();
  const needle = text.toLowerCase();
  const pages = VIEW_ITEMS.filter((item) => item.title.toLowerCase().includes(needle));
  const settings = settingsItems(needle);
  if (!needle) return [...pages, ...settings];
  const issues = issueItems(needle, data.issues);
  const id = text.toUpperCase();
  const typed: PaletteItem[] =
    ISSUE_ID.test(text) && !issues.some((item) => item.issue === id)
      ? [
          {
            group: "Issues",
            title: "Open issue",
            path: routePath({ view: "issues", id }),
            issue: id,
          },
        ]
      : [];
  return [...pages, ...settings, ...typed, ...issues, ...pullItems(needle, data.queue)];
}

async function readList<T>(
  path: string,
  parse: (input: unknown) => { ok: true; response: T } | { ok: false; error: string },
): Promise<T | null> {
  try {
    const response = await fetch(path, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const parsed = parse(await response.json());
    return parsed.ok ? parsed.response : null;
  } catch (error) {
    journalCaught(error, "command-palette.readList", null);
    return null;
  }
}

export function shortcutLabel(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘K"
    : "Ctrl K";
}

export function CommandPalette({ onNavigate }: { onNavigate(path: string): void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigated = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const listbox = useId();
  const [data, setData] = useState<PaletteData | null>(null);
  const items = paletteItems(query, data ?? undefined);
  const current = Math.min(active, items.length - 1);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    navigated.current = false;
    setQuery("");
    setActive(0);
    let live = true;
    void Promise.all([
      readList(ISSUES_API_PATH, parseIssueListResponse),
      readList(MERGE_QUEUE_API_PATH, parseMergeQueueResponse),
    ]).then(([list, queue]) => {
      if (live) setData({ issues: list?.issues ?? [], queue });
    });
    return () => {
      live = false;
      setData(null);
    };
  }, [open]);

  useEffect(() => {
    if (open)
      document.getElementById(`${listbox}-${current}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, listbox, current]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    navigated.current = true;
    setOpen(false);
    onNavigate(item.path);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        render={
          <Button ref={trigger} type="button" variant="neutral" size="sm" aria-label="Jump to…" />
        }
      >
        <Search aria-hidden="true" />
        <span className="hidden text-muted-foreground sm:inline">Jump to…</span>
        <kbd className="hidden rounded-base border border-border px-1.5 font-mono text-xs text-muted-foreground sm:inline">
          {shortcutLabel()}
        </kbd>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Popup
          initialFocus={input}
          finalFocus={() =>
            navigated.current ? document.querySelector<HTMLElement>("#content") : trigger.current
          }
          className="fixed left-1/2 top-[15vh] z-50 flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 flex-col overflow-hidden rounded-base border border-border bg-secondary-background text-foreground outline-none"
        >
          <Dialog.Title className="sr-only">Jump to</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={input}
              role="combobox"
              aria-label="Jump to"
              aria-expanded={items.length > 0}
              aria-controls={listbox}
              aria-autocomplete="list"
              aria-activedescendant={current >= 0 ? `${listbox}-${current}` : undefined}
              placeholder="Search pages, settings, issues and pull requests…"
              autoComplete="off"
              spellCheck={false}
              className="min-h-control w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  if (items.length > 0) setActive((current + step + items.length) % items.length);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  choose(items[current]);
                }
              }}
            />
          </div>
          <ul
            id={listbox}
            role="listbox"
            aria-label="Results"
            className="max-h-80 overflow-y-auto py-1"
          >
            {items.map((item, index) => (
              <Fragment key={`${item.group}:${item.path}`}>
                {item.group !== items[index - 1]?.group && (
                  <li
                    role="presentation"
                    className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground"
                  >
                    {item.group}
                  </li>
                )}
                <li
                  id={`${listbox}-${index}`}
                  role="option"
                  aria-selected={index === current}
                  className={cn(
                    "flex cursor-pointer items-baseline gap-2 px-3 py-2 text-sm",
                    index === current && "bg-accent",
                  )}
                  onMouseMove={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item)}
                >
                  {item.group === "Issues" && item.issue && (
                    <span className="shrink-0 font-mono text-xs">{item.issue}</span>
                  )}
                  <span className="min-w-0 truncate">{item.title}</span>
                  {item.detail && (
                    <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                      {item.detail}
                    </span>
                  )}
                </li>
              </Fragment>
            ))}
            {items.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">
                {data ? "No settings, issues or pull requests match." : "Searching…"}
              </li>
            )}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
