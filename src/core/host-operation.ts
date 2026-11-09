// Keep names through the next timer sample, including handlers that unblock before it runs.
const operations = new Set<string>();
const active = new Map<string, number>();
export function trackHostOperation<T>(name: string, run: () => T): T {
  operations.add(name);
  active.set(name, (active.get(name) ?? 0) + 1);
  const finish = () => {
    const count = (active.get(name) ?? 1) - 1;
    if (count) active.set(name, count);
    else active.delete(name);
    operations.add(name);
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(finish) as T;
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

export function sampleHostOperations(): string {
  const names = [...new Set([...operations, ...active.keys()])].join(",") || "idle";
  operations.clear();
  return names;
}
