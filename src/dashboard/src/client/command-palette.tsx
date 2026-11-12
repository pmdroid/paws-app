import { Dialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { NAVIGATION, PAGES } from "./navigation";
import { routePath, type Route } from "./route";
import { SETTINGS_PAGES } from "./settings-pages";
import { Button } from "./ui/button";
import { cn } from "./ui/utils";

export type PaletteItem = { title: string; path: string; issue: string | null };

const ISSUE_ID = /^[a-z]+-\d+$/i;

const PAGE_ITEMS: PaletteItem[] = [
  ...NAVIGATION.flatMap((group) => group.views).map((view) => ({
    title: PAGES[view].title,
    path: routePath({ view, id: null } as Route),
    issue: null,
  })),
  ...SETTINGS_PAGES.map((page) => ({
    title: `Settings · ${page.name}`,
    path: routePath({ view: "settings", page: page.id }),
    issue: null,
  })),
];

export function paletteItems(query: string): PaletteItem[] {
  const text = query.trim();
  const needle = text.toLowerCase();
  const pages = PAGE_ITEMS.filter((item) => item.title.toLowerCase().includes(needle));
  if (!ISSUE_ID.test(text)) return pages;
  const id = text.toUpperCase();
  return [
    { title: `Open issue ${id}`, path: routePath({ view: "issues", id }), issue: id },
    ...pages,
  ];
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
  const items = paletteItems(query);
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
              placeholder="Jump to a page or type an issue id…"
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
            aria-label="Pages"
            className="max-h-80 overflow-y-auto py-1"
          >
            {items.map((item, index) => (
              <li
                key={item.path}
                id={`${listbox}-${index}`}
                role="option"
                aria-selected={index === current}
                className={cn("cursor-pointer px-3 py-2 text-sm", index === current && "bg-accent")}
                onMouseMove={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
              >
                {item.issue ? (
                  <>
                    Open issue <span className="font-mono text-xs">{item.issue}</span>
                  </>
                ) : (
                  item.title
                )}
              </li>
            ))}
            {items.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">No page matches.</li>
            )}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
