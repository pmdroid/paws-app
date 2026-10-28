import { createElement, type ReactElement } from "react";
import {
  attributesToProps,
  domToReact,
  Element,
  type DOMNode,
  type HTMLReactParserOptions,
} from "html-react-parser";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Flex,
  Grid,
  Heading,
  Link,
  Text,
  Theme,
} from "@radix-ui/themes";

type Color = "green" | "red" | "amber" | "orange" | "blue" | "gray";

const options: HTMLReactParserOptions = { replace };

export function RadixIssuePage({ node }: { node: Element }) {
  return (
    <Theme
      accentColor="orange"
      grayColor="mauve"
      radius="medium"
      appearance="inherit"
      hasBackground
      style={{ borderRadius: "var(--radius-5)", minWidth: 0 }}
    >
      <Box p={{ initial: "4", sm: "6" }}>
        <Flex asChild direction="column" gap="6" minWidth="0">
          <article {...attributesToProps(unclassed(node.attribs))}>{children(node)}</article>
        </Flex>
      </Box>
    </Theme>
  );
}

function children(node: Element) {
  return domToReact(node.children as DOMNode[], options);
}

function stateColor(classes: Set<string>): Color {
  const has = (...names: string[]) => names.some((name) => classes.has(name));
  if (has("err", "bad", "failed", "exhausted", "needs_human", "rejected", "blocked", "stopped"))
    return "red";
  if (has("merged", "completed", "accepted", "passed", "done", "ok")) return "green";
  if (has("awaiting_input", "warn", "paused", "usage-pause-card")) return "amber";
  if (has("running", "verifying", "now", "merge_queue")) return "orange";
  return "gray";
}

function unclassed(attribs: Record<string, string>): Record<string, string> {
  const { class: _class, ...rest } = attribs;
  return rest;
}

const MONO = { fontFamily: "var(--code-font-family)" };

function replace(node: DOMNode): ReactElement | undefined {
  if (!(node instanceof Element)) return;
  const { name, attribs } = node;
  const classes = new Set((attribs.class ?? "").split(/\s+/));
  const has = (...names: string[]) => names.some((value) => classes.has(value));
  const props = attributesToProps(unclassed(attribs));
  const kids = () => children(node);
  const color = stateColor(classes);

  if (has("sr-only")) return;
  if (has("crumbs")) return <></>;
  if (name === "h1")
    return (
      <Heading as="h1" size={{ initial: "6", sm: "8" }} {...props}>
        {kids()}
      </Heading>
    );
  if (name === "h2")
    return (
      <Heading as="h2" size="4" {...props}>
        {kids()}
      </Heading>
    );
  if (name === "h3")
    return (
      <Heading as="h3" size="3" {...props}>
        {kids()}
      </Heading>
    );
  if (name === "h4")
    return (
      <Heading as="h4" size="2" {...props}>
        {kids()}
      </Heading>
    );

  if (name === "section" && has("closeout-result", "queue-notice"))
    return calloutFrom(node, has("queue-notice") ? "gray" : color, "section");
  if (has("closeout-result"))
    return calloutFrom(
      node,
      has("running") ? "blue" : has("usage-pause-card") ? "amber" : color,
      "div",
    );

  if (name === "ol" && has("run-stepper"))
    return (
      <Flex asChild wrap="wrap" gap="2" m="0" p="0" style={{ listStyle: "none" }}>
        <ol {...props}>{kids()}</ol>
      </Flex>
    );
  if (name === "li" && has("run-step"))
    return (
      <Badge
        asChild
        size="3"
        variant={has("now") ? "solid" : "soft"}
        color={has("done") ? "green" : has("failed") ? "red" : has("now") ? "orange" : "gray"}
      >
        <li {...props}>{kids()}</li>
      </Badge>
    );

  if (name === "dl" && has("issue-facts-grid"))
    return (
      <Grid asChild columns={{ initial: "2", sm: "3", md: "6" }} gapX="5" gapY="4" m="0">
        <dl {...props}>{kids()}</dl>
      </Grid>
    );
  if (name === "dt")
    return (
      <Text asChild size="1" color="gray">
        <dt {...props}>{kids()}</dt>
      </Text>
    );
  if (name === "dd")
    return (
      <Text asChild size="2" weight="medium">
        <dd {...props} style={{ margin: 0 }}>
          {kids()}
        </dd>
      </Text>
    );

  if (has("st", "tag", "pill", "ico"))
    return (
      <Badge size={has("st") ? "2" : "1"} variant="soft" color={color} {...props}>
        {kids()}
      </Badge>
    );
  if (has("lin-id"))
    return (
      <Code variant="ghost" color="gray" {...props}>
        {kids()}
      </Code>
    );

  if (name === "button" && has("section-toggle"))
    return (
      <Card asChild size="2">
        <button
          {...props}
          type="button"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            width: "100%",
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          {kids()}
        </button>
      </Card>
    );
  if (name === "button" && has("chk"))
    return (
      <button
        {...props}
        type="button"
        className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-8)]"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          width: "100%",
          padding: "var(--space-3)",
          textAlign: "left",
          cursor: "pointer",
          background: "none",
          border: 0,
          color: "inherit",
          font: "inherit",
          minWidth: 0,
        }}
      >
        {kids()}
      </button>
    );
  if (name === "button") {
    const solid = attribs["aria-pressed"] === "true" || has("primary");
    return (
      <Button
        {...props}
        type={(attribs.type as "button" | "submit" | undefined) ?? "button"}
        size="2"
        variant={solid ? "solid" : has("ghost") ? "ghost" : "soft"}
        color={solid ? undefined : "gray"}
      >
        {kids()}
      </Button>
    );
  }
  if (name === "a" && has("btn"))
    return (
      <Button asChild size="2" variant="soft" color="gray">
        <a {...props}>{kids()}</a>
      </Button>
    );
  if (name === "a") return <Link {...props}>{kids()}</Link>;

  if (has("check-chevron"))
    return (
      <Text color="gray" ml="auto" aria-hidden>
        {kids()}
      </Text>
    );
  if (has("check-name"))
    return (
      <Text size="2" weight="bold" style={MONO}>
        {kids()}
      </Text>
    );
  if (has("check-meta"))
    return (
      <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
        {kids()}
      </Text>
    );
  if (has("check-command", "mono"))
    return (
      <Text
        size="1"
        color="gray"
        style={{
          ...MONO,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          flex: has("check-command") ? "1 1 auto" : undefined,
        }}
      >
        {kids()}
      </Text>
    );
  if (has("muted", "dim"))
    return (
      <Text as={name === "p" ? "p" : "span"} size="2" color="gray" {...props}>
        {kids()}
      </Text>
    );

  if (has("check-row"))
    return (
      <Card size="1" {...props} style={{ padding: 0, minWidth: 0 }}>
        {kids()}
      </Card>
    );
  if (has("check-detail"))
    return (
      <Flex direction="column" gap="3" p="3" pt="0" {...props}>
        {kids()}
      </Flex>
    );
  if (has("log"))
    return (
      <Card
        {...props}
        tabIndex={0}
        variant="surface"
        style={{ maxHeight: "30rem", overflow: "auto" }}
      >
        <Flex direction="column" gap="1">
          {kids()}
        </Flex>
      </Card>
    );
  if (has("ln"))
    return (
      <Flex gap="3" align="baseline" {...props}>
        {kids()}
      </Flex>
    );
  if (has("ts"))
    return (
      <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
        {kids()}
      </Text>
    );
  if (has("ty"))
    return (
      <Badge size="1" variant="soft" color="gray">
        {kids()}
      </Badge>
    );
  if (has("tx")) return <Text size="2">{kids()}</Text>;
  if (name === "pre")
    return (
      <Box
        asChild
        p="3"
        style={{
          ...MONO,
          fontSize: "var(--font-size-1)",
          background: "var(--gray-a3)",
          borderRadius: "var(--radius-3)",
          overflow: "auto",
          maxHeight: "30rem",
          margin: 0,
        }}
      >
        <pre {...props}>{kids()}</pre>
      </Box>
    );

  if (has("between", "closeout-toolbar", "terminal-toolbar"))
    return (
      <Flex justify="between" align="center" wrap="wrap" gap="3" {...props}>
        {kids()}
      </Flex>
    );
  if (has("row", "attempt-tabs"))
    return (
      <Flex align="center" wrap="wrap" gap="2" {...props}>
        {kids()}
      </Flex>
    );
  if (has("check-list"))
    return (
      <Flex direction="column" gap="2" {...props}>
        {kids()}
      </Flex>
    );
  if (name === "header" || name === "section" || has("min-w-0", "check-terminal"))
    return createElement(
      name,
      {
        ...props,
        style: { display: "flex", flexDirection: "column", gap: "var(--space-3)", minWidth: 0 },
      },
      kids(),
    );
  if ((name === "ol" || name === "ul") && attribs.role === "list")
    return (
      <Flex asChild direction="column" gap="2" m="0" p="0" style={{ listStyle: "none" }}>
        {createElement(name, props, kids())}
      </Flex>
    );
  if (has("run-setup-item"))
    return (
      <Flex asChild gap="2" align="baseline" wrap="wrap">
        <li {...props}>{kids()}</li>
      </Flex>
    );
  if (name === "li")
    return (
      <Text asChild size="2">
        <li {...props}>{kids()}</li>
      </Text>
    );
  if (name === "p")
    return (
      <Text as="p" size="2" {...props}>
        {kids()}
      </Text>
    );
  if (name === "code")
    return (
      <Code variant="soft" color="gray" {...props}>
        {kids()}
      </Code>
    );
  return;
}

function calloutFrom(node: Element, color: Color, tag: "section" | "div"): ReactElement {
  const [icon, ...rest] = node.children.filter(
    (child): child is Element => child instanceof Element,
  );
  const body = icon?.attribs.class?.includes("result-icon") ? rest : [icon!, ...rest];
  return createElement(
    tag,
    attributesToProps(unclassed(node.attribs)),
    <Callout.Root color={color} variant="soft">
      {icon?.attribs.class?.includes("result-icon") ? (
        <Callout.Icon>
          <Text weight="bold">{children(icon)}</Text>
        </Callout.Icon>
      ) : null}
      <Flex direction="column" gap="1" minWidth="0">
        {domToReact(body as DOMNode[], options)}
      </Flex>
    </Callout.Root>,
  );
}
