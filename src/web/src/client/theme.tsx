import { createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import parse, {
  attributesToProps,
  domToReact,
  Element,
  type DOMNode,
  type HTMLReactParserOptions,
} from "html-react-parser";
import { buttonVariants } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table";
import { cn } from "./ui/utils";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";

const SETTINGS_SECTION_LAYOUT =
  "grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)] [&>*]:min-w-0";

const roots = new WeakMap<globalThis.Element, Root>();
let revision = 0;

export function renderMarkup(root: globalThis.Element, html: string): void {
  for (const child of root.querySelectorAll("*")) {
    const mounted = roots.get(child);
    if (!mounted) continue;
    flushSync(() => mounted.unmount());
    roots.delete(child);
  }
  let reactRoot = roots.get(root);
  if (!reactRoot) {
    reactRoot = createRoot(root);
    roots.set(root, reactRoot);
  }
  const content = themedMarkup(html);
  flushSync(() =>
    reactRoot.render(
      ["DETAILS", "P", "SPAN"].includes(root.tagName) ? (
        content
      ) : (
        <div
          key={++revision}
          className={
            root.classList.contains("settings-section")
              ? SETTINGS_SECTION_LAYOUT
              : root.classList.contains("row")
                ? "flex min-w-0 flex-wrap items-center gap-3"
                : root.id === "top"
                  ? "flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                  : "flex min-w-0 flex-col gap-6 [overflow-wrap:anywhere]"
          }
        >
          {content}
        </div>
      ),
    ),
  );
}

export function themedMarkup(html: string): ReactNode {
  return parse(html, options);
}

function ViewTabs({ node }: { node: Element }) {
  const panels = node.children.filter(
    (child): child is Element => child instanceof Element && Boolean(child.attribs["data-tab"]),
  );
  return (
    <Tabs
      className="@container"
      defaultValue={node.attribs["data-selected"]}
      onValueChange={(value) => {
        document.dispatchEvent(new CustomEvent("paws:epic-view", { detail: value }));
      }}
    >
      <TabsList aria-label={node.attribs["aria-label"] ?? "View"} className="mb-4 max-w-full">
        {panels.map((panel) => (
          <TabsTrigger
            key={panel.attribs["data-tab"]}
            value={panel.attribs["data-tab"]!}
            className="min-h-control px-4"
          >
            {panel.attribs["data-label"]}
          </TabsTrigger>
        ))}
      </TabsList>
      {panels.map((panel) => (
        <TabsContent key={panel.attribs["data-tab"]} value={panel.attribs["data-tab"]!}>
          {domToReact(panel.children as DOMNode[], options)}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function replace(node: DOMNode): ReactElement | undefined {
  if (!(node instanceof Element)) return;
  const { name, attribs } = node;
  if ("data-view-tabs" in attribs) return <ViewTabs node={node} />;
  const classes = new Set((attribs.class ?? "").split(/\s+/));
  const has = (...names: string[]) => names.some((value) => classes.has(value));
  const props = attributesToProps(attribs);
  delete props.style;
  const children = () => domToReact(node.children as DOMNode[], options);
  const styled = (className: string) =>
    createElement(name, { ...props, className: cn(attribs.class, className) }, children());
  if (name === "svg")
    return createElement(
      "svg",
      { ...props, width: attribs.width ?? 16, height: attribs.height ?? 16, "aria-hidden": true },
      children(),
    );
  if (name === "input") {
    if (props.value !== undefined) props.defaultValue = props.value;
    delete props.value;
    if (attribs.type === "checkbox" || attribs.type === "radio") {
      if (props.checked !== undefined) props.defaultChecked = props.checked;
      delete props.checked;
      return createElement("input", {
        ...props,
        className:
          "size-5 shrink-0 accent-main focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
      });
    }
    if (attribs.type === "hidden") return createElement("input", props);
    return <Input {...props} />;
  }
  if (name === "select") {
    const choices = node.children.filter(
      (child): child is Element => child instanceof Element && child.name === "option",
    );
    const selected = choices.find((choice) => "selected" in choice.attribs) ?? choices[0];
    const value =
      selected?.attribs.value ??
      selected?.children.map((child) => ("data" in child ? child.data : "")).join("");
    return (
      <NativeSelect {...props} defaultValue={value}>
        {choices.map((choice, index) => (
          <option key={index} value={choice.attribs.value} disabled={"disabled" in choice.attribs}>
            {domToReact(choice.children as DOMNode[])}
          </option>
        ))}
      </NativeSelect>
    );
  }
  if (name === "textarea")
    return (
      <Textarea
        {...props}
        defaultValue={node.children.map((child) => ("data" in child ? child.data : "")).join("")}
      />
    );
  if (name === "button") {
    if (has("chk"))
      return styled(
        "flex w-full flex-wrap items-center gap-3 rounded-base border-2 border-border bg-secondary-background p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
      );
    return createElement(
      "button",
      {
        ...props,
        type: attribs.type ?? "button",
        "data-slot": "button",
        "aria-pressed":
          attribs["aria-pressed"] === "true"
            ? "true"
            : attribs["aria-pressed"] === "false"
              ? "false"
              : undefined,
        className: cn(
          attribs.class,
          buttonVariants({
            variant: has("primary") || attribs["aria-pressed"] === "true" ? "default" : "neutral",
            size: "default",
          }),
        ),
      },
      children(),
    );
  }
  if (name === "a") {
    if (has("node"))
      return styled(
        "flex flex-col gap-3 rounded-base border-2 border-border bg-secondary-background p-4 shadow-shadow transition-transform hover:translate-x-1 hover:translate-y-1 hover:shadow-none",
      );
    if (has("btn", "nav", "tab", "conversation-tab") || attribs["aria-current"])
      return styled(
        buttonVariants({
          variant: attribs["aria-current"] || has("primary", "on") ? "default" : "neutral",
          size: "sm",
        }),
      );
    return styled(
      has("work-title")
        ? "font-bold underline-offset-4 hover:underline"
        : "font-semibold underline decoration-2 underline-offset-4 hover:decoration-main",
    );
  }
  if (name === "h1" && has("sr-only")) return styled("sr-only");
  if (/^h[1-6]$/.test(name))
    return styled(
      name === "h1"
        ? "text-3xl font-heading tracking-tight sm:text-4xl"
        : name === "h2"
          ? "text-xl font-heading"
          : "text-base font-heading",
    );
  if (name === "summary" && has("btn"))
    return styled(buttonVariants({ variant: "neutral", size: "sm" }));
  if (has("attempts")) return styled("flex items-center gap-2");
  if (
    name === "i" &&
    node.parent instanceof Element &&
    (node.parent.attribs.class ?? "").split(/\s+/).includes("attempts")
  )
    return styled(
      has("f")
        ? "inline-block h-3 w-6 rounded-base border-2 border-border bg-red-200"
        : has("p")
          ? "inline-block h-3 w-6 rounded-base border-2 border-border bg-green-200"
          : "inline-block h-3 w-6 rounded-base border-2 border-border bg-main",
    );
  if (has("conversation-message", "conversation-question", "conversation-row"))
    return styled(
      "space-y-3 rounded-base border-2 border-border bg-secondary-background px-4 py-4",
    );
  if (
    has(
      "conversation-timeline",
      "conversation-details",
      "conversation-plan",
      "conversation-files",
      "conversation-tasks",
      "settings-label",
      "settings-role",
    )
  )
    return styled(
      has("conversation-plan", "conversation-tasks", "conversation-files")
        ? "m-0 flex list-none flex-col gap-3 p-0 [&>li]:px-4 [&>li]:py-3"
        : "flex min-w-0 flex-col gap-4",
    );
  if (has("conversation-message-meta", "conversation-heading", "crumbs"))
    return styled("flex flex-wrap items-center gap-2");
  if (has("sr-only")) return styled("sr-only");
  if (has("logo", "av"))
    return styled(
      "inline-flex size-9 shrink-0 items-center justify-center rounded-base border-2 border-border bg-main text-sm font-bold text-main-foreground",
    );
  if (
    has(
      "st",
      "tag",
      "cnt",
      "n",
      "kind",
      "ico",
      "ph",
      "pill",
      "demo-pill",
      "live-pill",
      "conversation-delivery-state",
    )
  ) {
    const state = has("err", "bad", "failed", "exhausted", "needs_human", "rejected", "blocked")
      ? "bg-red-200 text-black"
      : has("merged", "completed", "accepted", "passed", "done", "ok")
        ? "bg-green-200 text-black"
        : has("awaiting_input", "warn", "paused")
          ? "bg-yellow-200 text-black"
          : has("running", "verifying", "now")
            ? "bg-main text-main-foreground"
            : "bg-secondary-background";
    return (
      <Badge {...props} className={cn(attribs.class, state)}>
        {children()}
      </Badge>
    );
  }
  if (name === "code" || has("lin-id"))
    return styled("rounded-base bg-background px-1.5 py-0.5 font-mono text-xs");
  if (name === "img")
    return createElement("img", {
      ...props,
      className: "h-auto max-w-full rounded-base border-2 border-border",
    });
  if (has("log", "scroll"))
    return createElement(
      "div",
      {
        ...props,
        "data-log": attribs["data-log"],
        tabIndex: 0,
        className:
          "max-h-120 overflow-auto rounded-base border-2 border-border bg-secondary-background p-3",
      },
      children(),
    );
  if (name === "pre")
    return styled(
      "max-h-120 overflow-auto rounded-base border-2 border-border bg-secondary-background p-4 font-mono text-xs",
    );
  if (name === "table") return <Table {...props}>{children()}</Table>;
  if (name === "thead") return <TableHeader {...props}>{children()}</TableHeader>;
  if (name === "tbody") return <TableBody {...props}>{children()}</TableBody>;
  if (name === "tr") return <TableRow {...props}>{children()}</TableRow>;
  if (name === "th")
    return (
      <TableHead {...props} className={has("hide-phone") ? "hidden sm:table-cell" : undefined}>
        {children()}
      </TableHead>
    );
  if (name === "td")
    return (
      <TableCell {...props} className={has("hide-phone") ? "hidden sm:table-cell" : undefined}>
        {children()}
      </TableCell>
    );
  if (has("status-meta")) return styled("flex min-w-0 flex-wrap items-center gap-3");
  if (has("status-actions"))
    return styled("grid grid-cols-2 gap-3 self-stretch sm:flex sm:shrink-0 sm:self-auto");
  if (has("epic-head")) return styled("space-y-3");
  if (has("epic-filters")) return styled("flex flex-wrap gap-2");
  if (name === "ul" && has("epic-list", "epic-items"))
    return styled(
      "m-0 list-none divide-y-2 divide-border rounded-base border-2 border-border bg-secondary-background p-0 [&>li]:px-4 [&>li]:py-4",
    );
  if (has("epic-row")) return styled("flex flex-wrap items-center justify-between gap-3 px-4 py-4");
  if (has("page-heading")) return styled("space-y-2");
  if (has("entity-picker")) return styled("flex w-full min-w-0 max-w-lg flex-col gap-2");
  if (has("overview-columns"))
    return styled(
      "grid min-w-0 grid-cols-1 items-stretch gap-6 xl:grid-cols-2 [&>*]:h-full [&>*]:min-w-0",
    );
  if (has("split", "conversation-layout"))
    return styled(
      "grid min-w-0 grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] [&>*]:min-w-0 [&>div:first-child]:space-y-4",
    );
  if (has("settings-navigation"))
    return styled("flex min-w-0 flex-wrap gap-3 [&>a]:grow sm:[&>a]:grow-0");
  if (has("settings-account")) return styled("flex min-w-0 flex-col items-start gap-4");
  if (has("settings-section")) return styled(SETTINGS_SECTION_LAYOUT);
  if (has("overview-section"))
    return styled(
      "flex min-w-0 flex-col gap-4 rounded-base border-2 border-border bg-secondary-background p-4 shadow-shadow sm:p-6",
    );
  if (has("kv")) return styled("grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 break-words");
  if (has("board", "dependency-levels"))
    return styled(
      "grid min-w-0 grid-cols-1 gap-4 @min-[32rem]:grid-cols-2 @min-[48rem]:grid-cols-3 [&>*]:min-w-0",
    );
  if (has("settings-controls"))
    return styled(
      "grid min-w-0 grid-cols-1 items-end gap-4 sm:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0 [&>button]:justify-self-start",
    );
  if (has("settings-field")) return styled("flex min-w-0 flex-col gap-2");
  if (name === "details") return styled("my-2 space-y-4");
  if (has("card", "q", "runner-section", "login-panel"))
    return (
      <Card {...props} className={cn(attribs.class, "min-w-0 bg-secondary-background p-4 sm:p-6")}>
        {children()}
      </Card>
    );
  if (name === "label")
    return styled(
      has("field", "settings-field")
        ? "flex min-w-0 flex-col gap-2 text-sm font-semibold"
        : "flex flex-wrap items-center gap-2 text-sm font-semibold",
    );
  if (has("ws")) return styled("hidden space-y-1 text-sm md:block");
  if (has("primary-navigation", "work-navigation"))
    return styled("flex flex-wrap items-start gap-3 py-2 md:flex-col");
  if (has("sp")) return styled("grow");
  if (
    has(
      "row",
      "between",
      "tabs",
      "brand",
      "meta",
      "qh",
      "ln",
      "dialog-actions",
      "settings-actions",
      "agent",
      "phs",
      "legend",
      "artifact",
      "overview-epics",
      "settings-inherit",
      "conversation-tabs",
      "conversation-links",
    )
  )
    return styled(
      has("between", "qh")
        ? "flex flex-wrap items-center justify-between gap-3"
        : "flex flex-wrap items-center gap-3",
    );
  if (
    name === "form" ||
    name === "fieldset" ||
    has(
      "col",
      "settings-profile",
      "settings-project",
      "settings-fields",
      "settings-add",
      "stream",
      "check-detail",
      "phase",
      "steps",
      "qb",
    )
  )
    return styled("flex min-w-0 flex-col gap-4");
  if (name === "ul" && has("overview-work"))
    return styled("m-0 list-none divide-y-2 divide-border p-0");
  if (name === "li" || has("it", "act", "qe", "opt")) return styled("py-3");
  if (has("demo-bar", "live-bar", "err-bar"))
    return styled(
      "flex flex-wrap items-center gap-2 rounded-base border-2 border-border bg-secondary-background p-3 text-sm leading-relaxed",
    );
  if (has("empty", "decision", "ctx", "settings-message"))
    return styled(
      "rounded-base border-2 border-border bg-secondary-background p-4 text-sm leading-relaxed break-words",
    );
  if (name === "p" || name === "small" || has("dim", "muted", "sub", "k", "clock", "foot", "mono"))
    return styled(has("mono") ? "font-mono text-xs" : "text-sm leading-relaxed");
  if (name === "details") return styled("my-2 space-y-4");
  if (name === "summary")
    return styled("cursor-pointer text-sm font-bold underline-offset-4 hover:underline");
  return createElement(name, props, children());
}

const options: HTMLReactParserOptions = { replace };
