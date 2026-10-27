import { journal } from "../journal";

export const RESPONSE_SIZE_WINDOW_MS = 60_000;

/**
 * Keeps the largest status API response served in each minute and journals it once, so
 * payload growth shows up in `journalctl` before anyone notices a slow dashboard.
 */
export interface ResponseSizeJournal {
  record(path: string, bytes: number): void;
  /** Journals the current minute's largest response now, if it has one. */
  flush(): void;
}

export function createResponseSizeJournal(
  options: {
    now?: () => number;
    write?: (line: string) => void;
    /** Journals each minute when it ends. Off for tests that drive the clock. */
    timer?: boolean;
  } = {},
): ResponseSizeJournal {
  const now = options.now ?? Date.now;
  const write = options.write ?? journal;
  const timer = options.timer ?? true;
  let window: { start: number; path: string; bytes: number; responses: number } | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (pending !== null) clearTimeout(pending);
    pending = null;
    if (window === null) return;
    const { start, path, bytes, responses } = window;
    window = null;
    write(
      `status payload minute=${new Date(start).toISOString()} largest_bytes=${bytes} path=${path} responses=${responses}`,
    );
  };

  return {
    record(path, bytes) {
      const at = now();
      if (window !== null && at >= window.start + RESPONSE_SIZE_WINDOW_MS) flush();
      if (window === null) {
        const start = at - (at % RESPONSE_SIZE_WINDOW_MS);
        window = { start, path, bytes, responses: 1 };
        if (timer) {
          pending = setTimeout(flush, start + RESPONSE_SIZE_WINDOW_MS - at);
          pending.unref?.();
        }
        return;
      }
      window.responses += 1;
      if (bytes > window.bytes) {
        window.bytes = bytes;
        window.path = path;
      }
    },
    flush,
  };
}

/** The process's journal, shared by every status request it serves. */
export const statusResponseSizes = createResponseSizeJournal();
