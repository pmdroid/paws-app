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
    return (
      <Input
        {...props}
        className={cn(props.className as string | undefined, has("concurrency-input") && "w-16")}
      />
    );
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
        "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
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
    if (has("runner-row"))
      return styled(
        "flex min-w-0 flex-col gap-3 rounded-base border-2 border-border bg-secondary-background px-4 py-3 shadow-shadow transition-transform hover:translate-x-1 hover:translate-y-1 hover:shadow-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:flex-row sm:items-center sm:justify-between",
      );
    if (has("node"))
      return styled(
        "flex flex-col gap-3 rounded-base border-2 border-border bg-secondary-background p-4 shadow-shadow transition-transform hover:translate-x-1 hover:translate-y-1 hover:shadow-none",
      );
    if (has("btn", "nav", "tab") || attribs["aria-current"])
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
  if (name === "summary" && (has("btn") || inRow(node)))
    return styled(
      cn(
        buttonVariants({ variant: has("on") ? "default" : "neutral", size: "default" }),
        "list-none [&::-webkit-details-marker]:hidden [&::marker]:content-none",
      ),
    );
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
  if (has("settings-label", "settings-role")) return styled("flex min-w-0 flex-col gap-4");
  if (has("crumbs")) return styled("flex flex-wrap items-center gap-2");
  if (has("sr-only")) return styled("sr-only");
  if (has("logo", "av"))
    return styled(
      "inline-block size-9 shrink-0 rounded-base border-2 border-border bg-main text-center text-sm font-bold leading-8 text-main-foreground",
    );
  if (has("st", "tag", "cnt", "n", "kind", "ico", "ph", "pill")) {
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
      <Badge
        {...props}
        className={cn(
          attribs.class,
          state,
          has("wrap") && "h-auto max-w-full whitespace-normal [overflow-wrap:anywhere]",
          has("outcome") && "h-auto whitespace-normal",
        )}
      >
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
  if (name === "table")
    return (
      <Table
        {...props}
        className={cn(
          has("runner-history", "merge-table") && "[overflow-wrap:normal]",
          has("runner-history") &&
            "max-sm:[&_td]:px-3 max-sm:[&_th]:px-3 [&_.lin-id]:whitespace-nowrap",
        )}
      >
        {children()}
      </Table>
    );
  if (name === "thead") return <TableHeader {...props}>{children()}</TableHeader>;
  if (name === "tbody") return <TableBody {...props}>{children()}</TableBody>;
  if (name === "tr") return <TableRow {...props}>{children()}</TableRow>;
  if (name === "th")
    return (
      <TableHead {...props} className={tableCell(has)}>
        {children()}
      </TableHead>
    );
  if (name === "td")
    return (
      <TableCell {...props} className={tableCell(has)}>
        {children()}
      </TableCell>
    );
  if (has("status-meta")) return styled("flex min-w-0 flex-wrap items-center gap-3");
  if (has("status-actions"))
    return styled("grid grid-cols-2 gap-3 self-stretch sm:flex sm:shrink-0 sm:self-auto");
  if (has("issue-head")) return styled("space-y-3");
  if (has("issue-filters")) return styled("flex flex-wrap gap-2");
  if (name === "ul" && has("issue-list", "issue-items"))
    return styled(
      "m-0 list-none divide-y-2 divide-border rounded-base border-2 border-border bg-secondary-background p-0 [&>li]:px-4 [&>li]:py-4",
    );
  if (name === "ul" && has("runner-rows"))
    return styled("m-0 flex list-none flex-col gap-3 p-0 [&>li]:p-0");
  if (has("runner-row-name")) return styled("flex min-w-0 flex-col gap-1 [&>b]:text-base");
  if (has("runner-row-tags")) return styled("flex flex-wrap gap-2 sm:justify-end");
  if (has("runner-head")) return styled("flex min-w-0 items-start justify-between gap-3");
  if (has("runner-title")) return styled("flex min-w-0 flex-col gap-2");
  if (has("runner-block"))
    return styled("flex min-w-0 flex-col gap-3 border-t-2 border-border pt-5");
  if (has("runner-block-head"))
    return styled("flex min-h-control min-w-0 flex-wrap items-center justify-between gap-3");
  if (name === "ul" && has("slot-list"))
    return styled(
      "m-0 grid min-w-0 list-none grid-cols-[auto_auto_minmax(0,1fr)] gap-x-3 gap-y-3 p-0 sm:grid-cols-[auto_auto_minmax(0,1fr)_auto]",
    );
  if (has("slot-row"))
    return styled(
      "col-span-full grid min-w-0 grid-cols-subgrid items-start gap-y-1 sm:items-center [&>.slot-facts]:col-start-3 sm:[&>.slot-facts]:col-start-auto [&>.lin-id]:justify-self-start [&>a.work-title]:col-span-2 [&>a.work-title]:min-w-0 [&>a.work-title]:break-words [&>span.muted]:col-span-2 sm:[&>span.muted]:col-span-3 [&>.slot-move]:col-span-2 [&>.slot-move]:col-start-2 sm:[&>.slot-move]:col-span-3 sm:[&>.slot-move]:col-start-2",
    );
  if (has("slot-mark"))
    return styled(
      cn(
        "h-6 w-3 rounded-base border-2 border-border",
        has("used")
          ? has("high")
            ? "bg-main"
            : "bg-gauge"
          : "border-dashed bg-secondary-background",
      ),
    );
  if (has("slot-facts")) return styled("flex items-center gap-2 text-sm");
  if (has("slot-move"))
    return styled(
      "flex min-w-0 flex-wrap items-center gap-2 [&>p]:m-0 [&>p]:min-w-0 [&>p]:break-words",
    );
  if (has("slot-note")) return styled("text-sm");
  if (has("runner-drain"))
    return styled(
      "flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-base border-2 border-border bg-secondary-background px-4 py-3",
    );
  if (has("runner-drain-state"))
    return styled(
      "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm [&>p]:m-0 [&>p]:min-w-0 [&>p]:break-words",
    );
  if (has("runner-status"))
    return styled(
      "flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold [&>span:not(.tag,:last-child)]:after:ml-3 [&>span:not(.tag,:last-child)]:after:content-['·']",
    );
  if (has("runner-meta"))
    return styled(
      "flex flex-wrap gap-x-2 text-sm leading-relaxed [&>span]:whitespace-nowrap [&>span:not(:last-child)]:after:ml-2 [&>span:not(:last-child)]:after:content-['·']",
    );
  if (has("runner-host")) return styled("flex min-w-0 flex-col gap-3");
  if (has("runner-gauges"))
    return styled(
      cn(
        "m-0 grid min-w-0 grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-4",
        has("stale") && "opacity-60 grayscale",
      ),
    );
  if (has("agent-usage")) return styled("flex min-w-0 flex-col gap-3");
  if (has("agent-limits"))
    return styled("m-0 grid min-w-0 grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2");
  if (has("gauge-bar")) return styled("flex h-4 items-center");
  if (has("runner-gauge"))
    return styled(
      "grid min-w-0 content-start grid-cols-[auto_minmax(0,1fr)] grid-rows-[1.75rem] items-center gap-x-2 gap-y-1.5 [&>dd]:m-0 [&>dd:nth-child(2)]:justify-self-end [&>dd:nth-child(n+3)]:col-span-full [&>dt]:text-sm [&>dt]:leading-6 [&>dt]:font-semibold [&>dt]:whitespace-nowrap",
    );
  if (has("gauge-value"))
    return styled(
      cn(
        "font-heading tabular-nums [overflow-wrap:normal]",
        has("high") &&
          "rounded-base border-2 border-border bg-main px-1.5 text-sm text-main-foreground",
      ),
    );
  if (has("gauge")) {
    const fill = Math.min(100, Math.max(0, Number(attribs["data-fill"]) || 0));
    return (
      <span
        {...props}
        className="flex h-4 w-full overflow-hidden rounded-base border-2 border-border bg-secondary-background"
      >
        <span
          className={cn(
            "h-full shrink-0",
            attribs["data-level"] === "high" ? "bg-main" : "bg-gauge",
            fill > 0 && fill < 100 && "border-r-2 border-border",
          )}
          style={{ width: `${fill}%` }}
        />
      </span>
    );
  }
  if (name === "ul" && has("runner-agent-list"))
    return styled("m-0 flex min-w-0 list-none flex-col gap-5 p-0");
  if (has("runner-agent"))
    return styled(
      "grid min-w-0 grid-cols-1 items-start gap-x-6 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)]",
    );
  if (has("runner-agent-name")) return styled("flex min-h-6 items-center gap-2 text-sm");
  if (name === "ul" && has("runner-skill-list", "run-setup-list"))
    return styled("m-0 flex min-w-0 list-none flex-col gap-3 p-0");
  if (has("runner-skill"))
    return styled(
      "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 text-sm [overflow-wrap:anywhere] [&>p]:col-span-full",
    );
  if (has("runner-agent-actions"))
    return styled("col-span-full flex min-w-0 flex-wrap items-center gap-2 pt-1");
  if (has("runner-skill-name", "run-setup-item"))
    return styled("flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm");
  if (has("runner-skill-error"))
    return styled(
      "rounded-base border-2 border-border bg-red-200 px-2 py-1 font-mono text-xs text-black",
    );
  if (has("run-setup"))
    return styled(
      "grid min-w-0 grid-cols-1 gap-x-6 gap-y-4 [overflow-wrap:anywhere] sm:grid-cols-[10rem_minmax(0,1fr)] [&>h2]:col-span-full [&>h3]:text-sm [&>h3]:font-semibold",
    );
  if (has("runner-settings")) return styled("flex min-w-0 flex-col gap-5");
  if (has("runner-setting"))
    return styled(
      "grid min-w-0 grid-cols-1 items-center gap-x-6 gap-y-2 sm:grid-cols-[10rem_minmax(0,1fr)]",
    );
  if (has("issue-row", "issue-title"))
    return styled(
      "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 [&>.st]:mt-0.5 [&>.st]:justify-self-end [&>.issue-facts]:col-span-full",
    );
  if (has("issue-facts")) return styled("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1");
  if (has("page-heading")) return styled("space-y-2");
  if (has("entity-picker")) return styled("flex w-full min-w-0 max-w-lg flex-col gap-2");
  if (has("overview-row"))
    return styled("flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4");
  if (has("overview-copy")) return styled("min-w-0 flex-1 basis-72 space-y-1 break-words");
  if (has("overview-summary")) return styled("text-sm font-semibold leading-relaxed");
  if (has("split"))
    return styled(
      "grid min-w-0 grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] [&>*]:min-w-0 [&>div:first-child]:space-y-4",
    );
  if (has("skill-name")) return styled("flex min-w-0 flex-wrap items-baseline gap-x-2");
  if (has("skill-runners")) return styled("mb-3 flex flex-col items-start gap-2");
  if (has("skill-actions")) return styled("flex flex-col items-stretch gap-2 sm:flex-row");
  if (has("skill-found")) return styled("flex min-w-0 flex-col gap-3");
  if (has("skill-pick"))
    return styled(
      "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 text-sm [overflow-wrap:anywhere] [&>input]:mt-1",
    );
  if (has("skill-pick-copy")) return styled("flex min-w-0 flex-col gap-1");
  if (has("checkout-repo-body")) return styled("flex min-w-0 flex-col gap-4");
  if (name === "ul" && has("checkout-paths"))
    return styled("m-0 list-none divide-y-2 divide-border border-y-2 border-border p-0");
  if (has("checkout-path")) return styled("flex min-w-0 flex-col gap-3 py-3");
  if (has("checkout-path-row"))
    return styled(
      "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 md:grid-cols-[minmax(0,1fr)_16rem_auto] max-md:[&>[data-slot=native-select-wrapper]]:col-span-full max-md:[&>[data-slot=native-select-wrapper]]:row-start-2",
    );
  if (has("checkout-path-name")) return styled("flex min-w-0 flex-wrap items-center gap-2");
  if (has("checkout-path-text")) return styled("font-mono text-sm [overflow-wrap:anywhere]");
  if (has("checkout-note"))
    return styled(
      cn(
        "space-y-1 rounded-base border-2 border-border p-3 text-sm leading-relaxed [overflow-wrap:anywhere]",
        has("warn") ? "bg-yellow-200 text-black" : "bg-background",
      ),
    );
  if (has("checkout-add")) return styled("flex min-w-0 flex-col gap-2");
  if (has("checkout-add-row"))
    return styled("grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]");
  if (has("checkout-error"))
    return styled(
      "rounded-base border-2 border-border bg-red-200 px-3 py-2 text-sm leading-relaxed text-black",
    );
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
  if (name === "dialog")
    return styled(
      "m-auto w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-base border-2 border-border bg-background p-0 text-foreground shadow-shadow outline-none backdrop:bg-overlay sm:max-w-lg",
    );
  if (has("dialog-body")) return styled("flex min-w-0 flex-col gap-4 p-6 [overflow-wrap:anywhere]");
  if (name === "details")
    return styled(
      inRow(node)
        ? "flex flex-col items-start gap-3 self-start [&:not([open])]:gap-0"
        : "my-2 space-y-4",
    );
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
  if (has("it") && has("row"))
    return styled(
      "grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3 py-1 [&>:nth-child(2)]:min-w-0",
    );
  if (has("ln"))
    return styled(
      "grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-3 [&>:nth-child(3)]:min-w-0",
    );
  if (has("qh"))
    return styled(
      "grid grid-cols-1 items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto] [&>.title]:col-span-full [&>.claim]:min-w-0 [&_a]:whitespace-nowrap",
    );
  if (has("claim")) return styled("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1");
  if (has("opts")) return styled("flex min-w-0 flex-col gap-1");
  if (has("opt"))
    return styled("grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-1");
  if (has("identity-link"))
    return styled(
      "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_9.5rem_auto] [&_label]:col-span-full [&_input]:col-span-full sm:[&_input]:col-span-1",
    );
  if (has("settings-roles")) return styled("flex min-w-0 flex-col gap-6");
  if (
    has(
      "row",
      "between",
      "tabs",
      "brand",
      "meta",
      "dialog-actions",
      "settings-actions",
      "agent",
      "phs",
      "legend",
      "artifact",
      "settings-inherit",
    )
  )
    return styled(
      has("between")
        ? "flex min-w-0 flex-wrap items-center justify-between gap-3"
        : "flex min-w-0 flex-wrap items-center gap-3",
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
  if (name === "li" || has("it", "act", "qe")) return styled("py-3");
  if (has("err-bar"))
    return styled(
      "flex flex-wrap items-center gap-2 rounded-base border-2 border-border bg-secondary-background p-3 text-sm leading-relaxed",
    );
  if (has("empty", "decision", "ctx", "settings-message"))
    return styled(
      "rounded-base border-2 border-border bg-secondary-background p-4 text-sm leading-relaxed break-words",
    );
  if (name === "p" || name === "small" || has("dim", "muted", "sub", "k", "clock", "foot", "mono"))
    return styled(has("mono") ? "font-mono text-xs" : "text-sm leading-relaxed");
  if (name === "summary")
    return styled("cursor-pointer text-sm font-bold underline-offset-4 hover:underline");
  return createElement(name, props, children());
}

function tableCell(has: (...names: string[]) => boolean): string | undefined {
  return (
    cn(
      has("hide-phone") && "hidden sm:table-cell",
      has("run-cell") && "px-2 py-3 sm:p-4",
      has("skill-cell") &&
        "skill-cell min-w-0 space-y-1 px-3 py-3 align-top [overflow-wrap:anywhere] sm:p-4",
      has("skill-state") && "skill-state w-px px-3 py-3 align-top [overflow-wrap:normal] sm:p-4",
    ) || undefined
  );
}

function inRow(node: Element): boolean {
  const parent = node.parent instanceof Element ? node.parent : null;
  const host = node.name === "summary" && parent?.name === "details" ? parent.parent : parent;
  return host instanceof Element && (host.attribs.class ?? "").split(/\s+/).includes("row");
}

const options: HTMLReactParserOptions = { replace };
