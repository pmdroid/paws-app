export type Timers = {
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (id: never) => void;
};
export type Visibility = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

/**
 * Runs `tick` every `every` ms while the document is visible, and once when it becomes visible
 * again. A hidden tab makes no requests. The returned function stops it.
 */
export function livePoll(
  tick: () => void,
  every: number,
  visibility: Visibility = document,
  timers: Timers = globalThis as unknown as Timers,
): () => void {
  const interval = timers.setInterval(() => {
    if (visibility.visibilityState === "visible") tick();
  }, every);
  const onVisibility = () => {
    if (visibility.visibilityState === "visible") tick();
  };
  visibility.addEventListener("visibilitychange", onVisibility);
  return () => {
    timers.clearInterval(interval as never);
    visibility.removeEventListener("visibilitychange", onVisibility);
  };
}
