import { AsyncLocalStorage } from "node:async_hooks";

type Operation = { name: string; now: () => number };
const context = new AsyncLocalStorage<Operation>();
let stalled = "idle";
let longest = 5000;
const active = new Map<string, number>();

function leave(name: string): void {
  const count = (active.get(name) ?? 1) - 1;
  if (count > 0) active.set(name, count);
  else active.delete(name);
}

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
  active.set(name, (active.get(name) ?? 0) + 1);
  let result: T;
  try {
    result = context.run({ name, now }, () => measureHostOperation(run));
  } catch (error) {
    leave(name);
    throw error;
  }
  if (!(result instanceof Promise)) {
    leave(name);
    return result;
  }
  return result.finally(() => leave(name)) as T;
}

export function activeHostOperations(): string {
  return active.size === 0 ? "idle" : [...active.keys()].sort().join(",");
}

export function sampleHostOperations(): string {
  const name = stalled;
  stalled = "idle";
  longest = 5000;
  return name;
}
