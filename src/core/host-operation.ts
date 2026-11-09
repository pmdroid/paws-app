import { AsyncLocalStorage } from "node:async_hooks";

type Operation = { name: string; now: () => number };
const context = new AsyncLocalStorage<Operation>();
let stalled = "idle";
let longest = 5000;

/** Measure synchronous work only; the operation context survives awaits. */
export function measureHostOperation<T>(run: () => T): T {
  const operation = context.getStore();
  if (!operation) return run();
  const at = operation.now();
  try {
    return run();
  } finally {
    const elapsed = operation.now() - at;
    if (elapsed > longest) {
      longest = elapsed;
      stalled = operation.name;
    }
  }
}

export function trackHostOperation<T>(
  name: string,
  run: () => T,
  now: () => number = () => performance.now(),
): T {
  return context.run({ name, now }, () => measureHostOperation(run));
}

export function sampleHostOperations(): string {
  const name = stalled;
  stalled = "idle";
  longest = 5000;
  return name;
}
