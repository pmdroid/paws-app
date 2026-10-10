/**
 * Repository-relative path patterns from Closeout draft 0.1 §5.3.
 *
 * A pattern that ends with `/` is a prefix. Any other pattern is a glob:
 * `*` and `?` match inside one segment, and a segment that is `**` matches
 * across segments.
 */

export function anyPathMatches(patterns: readonly string[], paths: readonly string[]): boolean {
  for (const pattern of patterns) {
    for (const path of paths) {
      if (pathMatches(pattern, path)) return true;
    }
  }
  return false;
}

export function pathMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  return matchSegments(pattern.split("/"), path.split("/"));
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  let patternIndex = 0;
  let pathIndex = 0;
  let starPattern: number | undefined;
  let starPath = 0;
  while (pathIndex < path.length) {
    const patternSegment = pattern[patternIndex];
    const pathSegment = path[pathIndex];
    if (patternIndex < pattern.length && patternSegment === "**") {
      starPattern = patternIndex;
      starPath = pathIndex;
      patternIndex += 1;
      continue;
    }
    if (
      patternIndex < pattern.length &&
      patternSegment !== undefined &&
      pathSegment !== undefined &&
      segmentMatches(patternSegment, pathSegment)
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

function segmentMatches(pattern: string, text: string): boolean {
  const patternChars = [...pattern];
  const textChars = [...text];
  let patternIndex = 0;
  let textIndex = 0;
  let star: number | undefined;
  let starText = 0;
  while (textIndex < textChars.length) {
    const patternChar = patternChars[patternIndex];
    const textChar = textChars[textIndex];
    if (patternIndex < patternChars.length && (patternChar === "?" || patternChar === textChar)) {
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
