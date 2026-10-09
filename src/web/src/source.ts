import { parseEngineUrl } from "./endpoint";

export type SourceChoice = { kind: "auto" } | { kind: "demo" } | { kind: "engine"; url: string };

export function choiceFromValue(value: string | null): SourceChoice | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "demo") return { kind: "demo" };
  const url = parseEngineUrl(trimmed);
  if (!url) return null;
  return { kind: "engine", url };
}

export function resolveEngineUrl(input: {
  choice: SourceChoice;
  baked: string | null;
  pathname: string;
  origin: string;
}): string | null {
  if (input.choice.kind === "demo") return null;
  if (input.choice.kind === "engine") return input.choice.url;
  const baked = input.baked ? parseEngineUrl(input.baked) : null;
  if (baked) return baked;
  if (input.pathname === "/status" || input.pathname.startsWith("/status/")) {
    const origin = parseEngineUrl(input.origin);
    return origin;
  }
  return null;
}
