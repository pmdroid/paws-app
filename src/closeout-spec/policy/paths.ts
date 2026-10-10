/**
 * Repository-relative paths and `paths` patterns from Closeout draft 0.1
 * sections 2 and 5.3. The runner imports {@link pathsMatch}.
 */

const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Item ids and import names. Schema validation reports the same rule. */
export function isSlug(value: string): boolean {
  return SLUG.test(value);
}

/**
 * A policy path: one or more segments separated by `/`.
 * A segment is not empty, `.`, or `..`. The path does not start with `/` or `~`
 * and does not contain a backslash. Returns the path when it stays inside the root.
 */
export function repoPath(value: string): string | undefined {
  if (value.length === 0 || value.length > 256) return undefined;
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("~")
  ) {
    return undefined;
  }
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") return undefined;
  }
  return value;
}

/** Section 5.3. `undefined` means the pattern is accepted. */
export function checkPathPattern(pattern: string): string | undefined {
  const body = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  if (
    body.length === 0 ||
    pattern.length > 256 ||
    pattern.startsWith("/") ||
    pattern.startsWith("!") ||
    pattern.includes("\\") ||
    pattern.includes("\0") ||
    drivePrefix(pattern) ||
    body.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return `path pattern is invalid: ${pattern}`;
  }
  return undefined;
}

export function checkPathPatterns(
  patterns: readonly string[],
): { ok: true; paths: string[] } | { ok: false; message: string } {
  const paths: string[] = [];
  for (const pattern of patterns) {
    const message = checkPathPattern(pattern);
    if (message !== undefined) return { ok: false, message };
    paths.push(pattern);
  }
  return { ok: true, paths };
}

/**
 * A trailing `/` matches a path that starts with that prefix.
 * `*` and `?` match inside one segment. A segment that is `**` matches across segments.
 */
export function pathsMatch(pattern: string, path: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  return matchSegments(pattern.split("/"), path.split("/"));
}

export function anyPathMatches(patterns: readonly string[], paths: readonly string[]): boolean {
  return patterns.some((pattern) => paths.some((path) => pathsMatch(pattern, path)));
}

function drivePrefix(pattern: string): boolean {
  if (pattern.length < 2) return false;
  const first = pattern.charCodeAt(0);
  const letter = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
  return letter && pattern.charCodeAt(1) === 58;
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  let patternIndex = 0;
  let pathIndex = 0;
  let starPattern: number | undefined;
  let starPath = 0;
  while (pathIndex < path.length) {
    const patternSegment = pattern[patternIndex];
    if (patternIndex < pattern.length && patternSegment === "**") {
      starPattern = patternIndex;
      starPath = pathIndex;
      patternIndex += 1;
      continue;
    }
    const pathSegment = path[pathIndex];
    if (
      patternIndex < pattern.length &&
      patternSegment !== undefined &&
      pathSegment !== undefined &&
      segmentMatch(patternSegment, pathSegment)
    ) {
      patternIndex += 1;
      pathIndex += 1;
      continue;
    }
    if (starPattern === undefined) return false;
    starPath += 1;
    if (starPath > path.length) return false;
    pathIndex = starPath;
    patternIndex = starPattern + 1;
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "**") {
    patternIndex += 1;
  }
  return patternIndex === pattern.length;
}

function segmentMatch(pattern: string, text: string): boolean {
  const patternChars = Array.from(pattern);
  const textChars = Array.from(text);
  let patternIndex = 0;
  let textIndex = 0;
  let star: number | undefined;
  let starText = 0;
  while (textIndex < textChars.length) {
    const patternChar = patternChars[patternIndex];
    const textChar = textChars[textIndex];
    if (
      patternIndex < patternChars.length &&
      patternChar !== undefined &&
      textChar !== undefined &&
      (patternChar === "?" || patternChar === textChar)
    ) {
      patternIndex += 1;
      textIndex += 1;
      continue;
    }
    if (patternIndex < patternChars.length && patternChar === "*") {
      star = patternIndex;
      starText = textIndex;
      patternIndex += 1;
      continue;
    }
    if (star === undefined) return false;
    starText += 1;
    textIndex = starText;
    patternIndex = star + 1;
  }
  while (patternIndex < patternChars.length && patternChars[patternIndex] === "*") {
    patternIndex += 1;
  }
  return patternIndex === patternChars.length;
}
