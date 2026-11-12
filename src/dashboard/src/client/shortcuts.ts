import { routePath, type Route } from "./route";

export const PAGE_SHORTCUTS: { keys: string; label: string; route: Route }[] = [
  { keys: "g o", label: "Overview", route: { view: "overview" } },
  { keys: "g i", label: "Issues", route: { view: "issues", id: null } },
  { keys: "g q", label: "Questions", route: { view: "questions", id: null } },
  { keys: "g m", label: "Merge queue", route: { view: "mergeQueue" } },
  { keys: "g r", label: "Runners", route: { view: "runners", id: null } },
  { keys: "g f", label: "Findings", route: { view: "findings" } },
  { keys: "g p", label: "Improvements", route: { view: "improvements", tab: "review", id: null } },
];

const SEQUENCE_WINDOW_MS = 1000;

export function shortcutFor(sequence: string): Route | "help" | null {
  if (sequence === "?") return "help";
  return PAGE_SHORTCUTS.find((shortcut) => shortcut.keys === sequence)?.route ?? null;
}

function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

export function createShortcuts({
  navigate,
  openHelp,
}: {
  navigate(path: string): void;
  openHelp(): void;
}): { dispose(): void } {
  let pending = 0;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (typing(event.target) || document.querySelector('[role="dialog"]')) return;
    const waiting = pending > 0 && Date.now() - pending <= SEQUENCE_WINDOW_MS;
    pending = 0;
    const key = event.key.length === 1 ? event.key : "";
    const shortcut = shortcutFor(waiting ? `g ${key.toLowerCase()}` : key);
    if (shortcut === "help") {
      event.preventDefault();
      openHelp();
    } else if (shortcut) {
      event.preventDefault();
      navigate(routePath(shortcut));
    } else if (!waiting && key.toLowerCase() === "g" && !event.shiftKey) {
      pending = Date.now();
    }
  };
  window.addEventListener("keydown", onKeyDown);
  return { dispose: () => window.removeEventListener("keydown", onKeyDown) };
}
