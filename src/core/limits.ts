/** Wall-clock gap that counts as a laptop sleep, not a scheduling stall. */
export const WAKE_GAP_MS = 30_000;

/** A run that slept longer than this restarts from fresh main. The WIP branch is kept. */
export const LONG_SLEEP_MS = 2 * 60 * 60 * 1000;

export const RESUME_AGAIN_AFTER_MS = 30 * 60_000;
