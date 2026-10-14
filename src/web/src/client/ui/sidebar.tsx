import type { ComponentProps } from "react";
import { cn } from "./utils";

export function Sidebar({ className, ...props }: ComponentProps<"aside">) {
  return (
    <aside
      data-slot="sidebar"
      className={cn(
        "w-sidebar min-w-0 self-stretch border-r-2 border-border bg-secondary-background text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn(
        "flex min-h-20 shrink-0 flex-col justify-center gap-3 border-b-2 border-border px-6 py-4",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain p-3", className)}
      {...props}
    />
  );
}

export function SidebarGroup({ className, ...props }: ComponentProps<"section">) {
  return (
    <section data-slot="sidebar-group" className={cn("mb-5 space-y-2", className)} {...props} />
  );
}

export function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("flex list-none flex-col gap-1", className)}
      {...props}
    />
  );
}

export function SidebarMenuLink({
  className,
  active,
  ...props
}: ComponentProps<"a"> & { active: boolean }) {
  return (
    <a
      data-slot="sidebar-menu-button"
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-control w-full items-center gap-3 rounded-base border-2 border-transparent px-3 py-2 text-sm font-semibold hover:border-border hover:bg-main hover:text-main-foreground focus-visible:outline-ring",
        active && "border-border bg-main text-main-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("shrink-0 border-t-2 border-border p-4 text-xs leading-relaxed", className)}
      {...props}
    />
  );
}
