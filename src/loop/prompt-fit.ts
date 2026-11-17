export const RUNNER_PROMPT_LIMIT = 65_536;
export const SHORTENED_MARKER = "[Shortened by Paws to fit the runner's prompt limit.]";
const SEPARATOR = "\n\n";
const RUNNER_ERROR_LINES = 20;

export type PromptPart = { text: string; keep?: boolean };

export function fitPrompt(
  parts: readonly PromptPart[],
  limit: number,
  measure: (text: string) => number = (text) => text.length,
): string {
  const texts = parts.filter((part) => part.text).map((part) => ({ ...part }));
  const join = () =>
    texts
      .map((part) => part.text)
      .filter(Boolean)
      .join(SEPARATOR);
  const size = () => {
    const kept = texts.filter((part) => part.text);
    return (
      kept.reduce((total, part) => total + measure(part.text), 0) +
      measure(SEPARATOR) * Math.max(0, kept.length - 1)
    );
  };
  for (const keep of [false, true]) {
    const done = new Set<number>();
    for (;;) {
      const excess = size() - limit;
      if (excess <= 0) return join();
      let index = -1;
      texts.forEach((part, at) => {
        if (Boolean(part.keep) !== keep || done.has(at) || !part.text) return;
        if (index === -1 || part.text.length > texts[index]!.text.length) index = at;
      });
      if (index === -1) break;
      done.add(index);
      const part = texts[index]!;
      part.text = shorten(part.text, measure(part.text) - excess, measure);
    }
  }
  return shorten(join(), limit, measure);
}

function shorten(text: string, target: number, measure: (text: string) => number): string {
  if (measure(text) <= target) return text;
  const suffix = `\n${SHORTENED_MARKER}`;
  if (measure(suffix) >= target) return "";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(text.slice(0, middle) + suffix) <= target) low = middle;
    else high = middle - 1;
  }
  const code = text.charCodeAt(low - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? low - 1 : low;
  return text.slice(0, end) + suffix;
}

export function boundRunnerError(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= RUNNER_ERROR_LINES) return text;
  const omitted = lines.length - RUNNER_ERROR_LINES;
  return `${lines.slice(0, RUNNER_ERROR_LINES).join("\n")}\n[${omitted} more ${omitted === 1 ? "line" : "lines"} left out; the full text is in the run's transcript.]`;
}
