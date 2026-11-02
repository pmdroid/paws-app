import { esc } from "./format";

type Style = {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  fg: number | null;
  bg: number | null;
};

const PLAIN: Style = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  fg: null,
  bg: null,
};

// CSI sequences. SGR (`m`) changes the style; every other CSI command is dropped.
// oxlint-disable-next-line no-control-regex -- terminal escapes are the input
const CSI = /\u001b\[([0-9;:?]*)([@-~])/g;
// Other escapes (OSC titles and links, charset selection, lone ESC) carry no text.
// oxlint-disable-next-line no-control-regex -- terminal escapes are the input
const OTHER = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[()][0-9A-Za-z]|\u001b[@-_]?/g;

/**
 * Turns terminal output into HTML. Each text run is HTML-escaped before it is
 * wrapped in a span, so output can never inject markup. Colors are the 16
 * standard ANSI colors (256-color indexes 0–15 map onto them); other extended
 * colors are ignored because the theme strips inline styles.
 */
export function ansiToHtml(input: string): string {
  let style = PLAIN;
  let out = "";
  let last = 0;
  const text = input.replace(/\r\n/g, "\n");
  for (const match of text.matchAll(CSI)) {
    out += run(text.slice(last, match.index), style);
    last = match.index + match[0].length;
    if (match[2] === "m") style = apply(style, match[1] ?? "");
  }
  out += run(text.slice(last), style);
  return out;
}

function run(chunk: string, style: Style): string {
  const clean = overwrite(chunk.replace(OTHER, ""));
  if (!clean) return "";
  const classes = classOf(style);
  return classes ? `<span class="${classes}">${esc(clean)}</span>` : esc(clean);
}

/** A bare carriage return redraws the line (progress bars); keep what was drawn last. */
function overwrite(chunk: string): string {
  if (!chunk.includes("\r")) return chunk;
  return chunk
    .split("\n")
    .map((line) => {
      const parts = line.split("\r").filter((part) => part.length > 0);
      return parts.at(-1) ?? "";
    })
    .join("\n");
}

function classOf(style: Style): string {
  const names: string[] = [];
  if (style.bold) names.push("ansi-bold");
  if (style.dim) names.push("ansi-dim");
  if (style.italic) names.push("ansi-italic");
  if (style.underline) names.push("ansi-underline");
  if (style.fg !== null) names.push(`ansi-fg-${style.fg}`);
  if (style.bg !== null) names.push(`ansi-bg-${style.bg}`);
  return names.join(" ");
}

function apply(current: Style, params: string): Style {
  const codes = params.length === 0 ? [0] : params.split(/[;:]/).map((part) => Number(part || 0));
  let style = { ...current };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) style = { ...PLAIN };
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code >= 30 && code <= 37) style.fg = code - 30;
    else if (code >= 90 && code <= 97) style.fg = code - 90 + 8;
    else if (code === 39) style.fg = null;
    else if (code >= 40 && code <= 47) style.bg = code - 40;
    else if (code >= 100 && code <= 107) style.bg = code - 100 + 8;
    else if (code === 49) style.bg = null;
    else if (code === 38 || code === 48) {
      const mode = codes[index + 1];
      const color = mode === 5 ? (codes[index + 2] ?? -1) : -1;
      const value = color >= 0 && color <= 15 ? color : null;
      if (code === 38) style.fg = value;
      else style.bg = value;
      index += mode === 5 ? 2 : mode === 2 ? 4 : 1;
    }
  }
  return style;
}
