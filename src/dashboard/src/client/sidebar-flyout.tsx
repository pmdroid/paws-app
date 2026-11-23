import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { routePath } from "./route";
import { settingsPageRoute, type SettingsPage } from "./settings-pages";
import { SidebarMenu, SidebarMenuLink } from "./ui/sidebar";

export const FLYOUT_OPEN_DELAY = 120;
export const FLYOUT_CLOSE_DELAY = 250;

function canHover() {
  return typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;
}

export function SidebarFlyoutItem({
  to,
  active,
  flyout,
  label,
  pages,
  onNavigate,
  children,
  submenu,
}: {
  to: string;
  active: boolean;
  flyout: boolean;
  label: string;
  pages: readonly { id: SettingsPage; name: string }[];
  onNavigate?: () => void;
  children: ReactNode;
  submenu: ReactNode;
}) {
  const enabled = flyout && !active && canHover();
  const [open, setOpen] = useState(false);
  const item = useRef<HTMLAnchorElement>(null);
  const panel = useRef<HTMLUListElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const focusFirst = useRef(false);
  const returning = useRef(false);

  const later = (next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  };
  const show = (focus: boolean) => {
    clearTimeout(timer.current);
    focusFirst.current = focus;
    setOpen(true);
    if (focus && open) entries()[0]?.focus();
  };
  const close = (refocus: boolean) => {
    clearTimeout(timer.current);
    setOpen(false);
    if (!refocus) return;
    returning.current = true;
    item.current?.focus();
    returning.current = false;
  };
  const entries = () => [
    ...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!enabled) close(false);
  }, [enabled]);
  useLayoutEffect(() => {
    if (!open || !item.current || !panel.current) return;
    const rect = item.current.getBoundingClientRect();
    const height = panel.current.offsetHeight;
    panel.current.style.left = `${rect.right + 8}px`;
    panel.current.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - height - 8))}px`;
    if (focusFirst.current) entries()[0]?.focus();
    focusFirst.current = false;
  }, [open]);

  const onItemKey = (event: KeyboardEvent) => {
    if (!enabled) return;
    if (event.key === "ArrowRight" || event.key === "Enter") {
      event.preventDefault();
      show(true);
    } else if (event.key === "Escape" || event.key === "ArrowLeft") {
      if (open) event.preventDefault();
      close(false);
    }
  };
  const onPanelKey = (event: KeyboardEvent) => {
    const list = entries();
    const index = list.indexOf(event.target as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      list[(index + step + list.length) % list.length]?.focus();
    } else if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };

  return (
    <li
      onPointerEnter={(event) => {
        if (enabled && event.pointerType !== "touch") later(true, FLYOUT_OPEN_DELAY);
      }}
      onPointerLeave={() => {
        if (enabled) later(false, FLYOUT_CLOSE_DELAY);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(false);
      }}
    >
      <SidebarMenuLink
        ref={item}
        to={to}
        active={active}
        aria-current={undefined}
        aria-haspopup={enabled ? "menu" : undefined}
        aria-expanded={enabled ? open : undefined}
        onClick={() => {
          close(false);
          onNavigate?.();
        }}
        onFocus={(event) => {
          if (enabled && !returning.current && event.currentTarget.matches(":focus-visible"))
            show(false);
        }}
        onKeyDown={onItemKey}
      >
        {children}
      </SidebarMenuLink>
      {active && submenu}
      {enabled && open && (
        <SidebarMenu
          ref={panel}
          role="menu"
          aria-label={label}
          onKeyDown={onPanelKey}
          className="fixed z-30 w-52 gap-0.5 rounded-base border border-border bg-secondary-background p-1 shadow-lg"
        >
          {pages.map((page) => (
            <li key={page.id} role="none">
              <SidebarMenuLink
                role="menuitem"
                tabIndex={-1}
                to={routePath(settingsPageRoute(page.id))}
                active={false}
                onClick={() => {
                  close(false);
                  onNavigate?.();
                }}
                className="text-[13px]"
              >
                {page.name}
              </SidebarMenuLink>
            </li>
          ))}
        </SidebarMenu>
      )}
    </li>
  );
}
