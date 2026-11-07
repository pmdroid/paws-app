const QUOTE_END: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };

function skipQuoted(text: string, at: number): number {
  const end = QUOTE_END[text[at]!];
  if (end === undefined) return at;
  const close = text.indexOf(end, at + 1);
  if (close < 0) throw new Error(`Unterminated quote in ${text}`);
  return close;
}

export function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    i = skipQuoted(text, i);
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  throw new Error(`Unbalanced parentheses in ${text}`);
}

export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    i = skipQuoted(text, i);
    if (text[i] === "(") i = closingParen(text, i);
    else if (text[i] === ",") {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function nextKeyword(text: string): { index: number; keyword: "CHECK" | "COLLATE" } | undefined {
  for (let i = 0; i < text.length; i++) {
    i = skipQuoted(text, i);
    if (text[i] === "(") i = closingParen(text, i);
    else if (i === 0 || !/\w/.test(text[i - 1]!)) {
      const match = /^(CHECK|COLLATE)\b/i.exec(text.slice(i));
      if (match) return { index: i, keyword: match[1]!.toUpperCase() as "CHECK" | "COLLATE" };
    }
  }
  return undefined;
}

export const unquoteName = (name: string) => name.replace(/^["`[]|["`\]]$/g, "");

export function createTableParts(sql: string): {
  checks: string[];
  collations: Record<string, string>;
} {
  const open = sql.indexOf("(");
  const checks: string[] = [];
  const collations: Record<string, string> = {};
  for (const part of splitTopLevel(sql.slice(open + 1, closingParen(sql, open)))) {
    const constraint = /^(?:CONSTRAINT\s+\S+\s+)?(PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.exec(part);
    if (constraint && constraint[1]!.toUpperCase() !== "CHECK") continue;
    const name = constraint ? undefined : /^\S+/.exec(part)![0];
    let rest = name === undefined ? part : part.slice(name.length);
    for (let found = nextKeyword(rest); found; found = nextKeyword(rest)) {
      if (found.keyword === "CHECK") {
        const start = rest.indexOf("(", found.index);
        const end = closingParen(rest, start);
        checks.push(rest.slice(start + 1, end).trim());
        rest = rest.slice(end + 1);
      } else {
        const collation = /^COLLATE\s+(\S+)/i.exec(rest.slice(found.index))!;
        if (name !== undefined) collations[unquoteName(name)] = unquoteName(collation[1]!);
        rest = rest.slice(found.index + collation[0].length);
      }
    }
  }
  return { checks, collations };
}
