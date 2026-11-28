import { esc } from "./format";

export type FieldSources = Record<
  string,
  { source: "environment"; variable: string } | { source: "settings" | "unset" } | undefined
>;

export function envVariable(sources: FieldSources | undefined, key: string): string | null {
  const entry = sources?.[key];
  return entry?.source === "environment" ? entry.variable : null;
}

export function envNote(variable: string): string {
  return `<small class="sub font-normal" data-env-source>Set by <code>${esc(variable)}</code> in the service environment</small>`;
}
