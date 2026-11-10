import type { Steps } from "../db";

/**
 * Runs another module's synchronous work, which writes through its own handle, as a
 * transaction body on the store, so it commits or rolls back with the transaction.
 */
// oxlint-disable-next-line require-yield
export function* syncSteps<T>(fn: () => T): Steps<T> {
  return fn();
}
