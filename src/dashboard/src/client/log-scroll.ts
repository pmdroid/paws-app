/** The parts of a `[data-log]` element a repaint reads and restores. */
export interface LogNode {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface LogRoot {
  querySelectorAll(selectors: string): Iterable<LogNode>;
}

export type LogScroll = { key: string; top: number; stick: boolean };

/** Where each log sits before a repaint. A log at its bottom follows new lines. */
export function captureLogs(root: LogRoot): LogScroll[] {
  const logs: LogScroll[] = [];
  for (const node of root.querySelectorAll("[data-log]")) {
    const key = node.getAttribute("data-log");
    if (!key) continue;
    const stick = node.scrollHeight - node.scrollTop - node.clientHeight <= 8;
    logs.push({ key, top: node.scrollTop, stick });
  }
  return logs;
}

/**
 * Puts each log back where the reader left it. A `data-follow` log seen for
 * the first time starts at its newest line.
 */
export function restoreLogs(root: LogRoot, logs: readonly LogScroll[]): void {
  for (const node of root.querySelectorAll("[data-log]")) {
    const saved = logs.find((entry) => entry.key === node.getAttribute("data-log"));
    if (saved) node.scrollTop = saved.stick ? node.scrollHeight : saved.top;
    else if (node.hasAttribute("data-follow")) followLog(node);
  }
}

export function followLog(node: LogNode): void {
  node.scrollTop = node.scrollHeight;
}
