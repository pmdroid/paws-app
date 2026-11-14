import { isAbsolute } from "node:path";
import { z } from "zod";
import type { PawsConfigFile } from "./file";

export type AgentCommands = {
  grok: { path: string | null; allowApiKey: boolean };
  opencode: { path: string | null };
};

const pathSchema = z.string().max(4096).nullable().optional();
const grokSchema = z.strictObject({ path: pathSchema, allowApiKey: z.boolean().optional() });
const opencodeSchema = z.strictObject({ path: pathSchema });

export function readAgentCommands(config: PawsConfigFile): AgentCommands {
  return {
    grok: { path: config.agents.grok.path, allowApiKey: config.agents.grok.allowApiKey },
    opencode: { path: config.agents.opencode?.path ?? null },
  };
}

export function parseAgentCommands(
  previous: AgentCommands,
  grok: unknown,
  opencode: unknown,
): AgentCommands {
  const grokBody = parseOrThrow(grokSchema, grok ?? {}, "grok");
  const opencodeBody = parseOrThrow(opencodeSchema, opencode ?? {}, "opencode");
  return {
    grok: {
      path: commandPath("grok", previous.grok.path, grokBody.path),
      allowApiKey: grokBody.allowApiKey ?? previous.grok.allowApiKey,
    },
    opencode: { path: commandPath("opencode", previous.opencode.path, opencodeBody.path) },
  };
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    `${name} must be an object with ${name === "grok" ? "path (an absolute path or null) and allowApiKey (a boolean)" : "path (an absolute path or null)"}`,
  );
}

function commandPath(
  agent: string,
  previous: string | null,
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === previous) return previous;
  const path = value?.trim() ?? "";
  if (path === "") return null;
  if (!isAbsolute(path) || [...path].some((char) => char.charCodeAt(0) < 32))
    throw new Error(`${agent}.path must be an absolute path`);
  return path;
}

export function setAgentCommandsText(text: string, commands: AgentCommands): string {
  let section = "";
  const retained = text
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) section = heading[1].trim();
      return !/^agents\.(grok|opencode)(?:\.|$)/i.test(section);
    })
    .join("\n")
    .trimEnd();
  const grok = ["[agents.grok]"];
  if (commands.grok.path !== null) grok.push(`path = ${JSON.stringify(commands.grok.path)}`);
  grok.push(`allow_api_key = ${commands.grok.allowApiKey}`);
  const sections = [retained, grok.join("\n")].filter((part) => part !== "");
  if (commands.opencode.path !== null)
    sections.push(`[agents.opencode]\npath = ${JSON.stringify(commands.opencode.path)}`);
  const next = `${sections.join("\n\n")}\n`;
  Bun.TOML.parse(next);
  return next;
}
