const SURVIVABLE = new Set(["TimeoutError", "AbortError"]);

export function handleUnhandledRejection(
  error: unknown,
  options: { journal: (error: unknown) => void; exit: (code: number) => void },
): void {
  options.journal(error);
  if (!(error instanceof Error || error instanceof DOMException) || !SURVIVABLE.has(error.name))
    options.exit(1);
}
