/**
 * Local copy of the changed-path matcher.
 *
 * QM-30 owns the real implementation in `src/closeout-spec/policy/` behind
 * `matchPaths(patterns, paths)`. This file keeps that signature so the runner
 * can filter setup steps and commands before that module lands. Replace this
 * copy with the policy export when QM-30 is available.
 *
 * Rules are Closeout 0.1 §5.3. A pattern that ends with `/` is a directory
 * prefix. Any other pattern is a glob: `*` and `?` stay inside one path
 * segment, and a segment that is `**` matches across segments.
 */

/** True when any pattern matches any changed path. */
export function matchPaths(patterns: readonly string[], paths: readonly string[]): boolean {
  for (const pattern of patterns) {
    for (const path of paths) {
      if (pathMatches(pattern, path)) return true;
    }
  }
  return false;
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  return matchSegments(pattern.split("/"), path.split("/"));
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  let patternIndex = 0;
  let pathIndex = 0;
  let starPattern: number | null = null;
  let starPath = 0;
  while (pathIndex < path.length) {
    const current = pattern[patternIndex];
    if (patternIndex < pattern.length && current === "**") {
      starPattern = patternIndex;
      starPath = pathIndex;
      patternIndex += 1;
      continue;
    }
    if (
      patternIndex < pattern.length &&
      current !== undefined &&
      segmentMatch(current, path[pathIndex] ?? "")
    ) {
      patternIndex += 1;
      pathIndex += 1;
      continue;
    }
    if (starPattern === null) return false;
    starPath += 1;
    if (starPath > path.length) return false;
    pathIndex = starPath;
    patternIndex = starPattern + 1;
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "**") patternIndex += 1;
  return patternIndex === pattern.length;
}

function segmentMatch(pattern: string, text: string): boolean {
  const patternChars = [...pattern];
  const textChars = [...text];
  let patternIndex = 0;
  let textIndex = 0;
  let star: number | null = null;
  let starText = 0;
  while (textIndex < textChars.length) {
    const current = patternChars[patternIndex];
    const textChar = textChars[textIndex];
    if (patternIndex < patternChars.length && (current === "?" || current === textChar)) {
      patternIndex += 1;
      textIndex += 1;
      continue;
    }
    if (patternIndex < patternChars.length && current === "*") {
      star = patternIndex;
      starText = textIndex;
      patternIndex += 1;
      continue;
    }
    if (star === null) return false;
    starText += 1;
    textIndex = starText;
    patternIndex = star + 1;
  }
  while (patternIndex < patternChars.length && patternChars[patternIndex] === "*")
    patternIndex += 1;
  return patternIndex === patternChars.length;
}
