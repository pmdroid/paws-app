/** Stop and cancel requested from a Linear agent session. */
export type LinearCommand = {
  type: "stop" | "cancel";
  itemId: string;
  source: "linear" | "dashboard";
  requestedAt: number;
};

export type CommandListener = (command: LinearCommand) => void;

export class CommandBus {
  private readonly listeners = new Set<CommandListener>();

  subscribe(listener: CommandListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(command: LinearCommand): void {
    for (const listener of this.listeners) listener(command);
  }
}

export function parseLinearCommand(payload: unknown): LinearCommand | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.type !== "stop" && record.type !== "cancel") return null;
  if (record.source !== "linear" && record.source !== "dashboard") return null;
  if (typeof record.itemId !== "string" || record.itemId.length === 0) return null;
  if (typeof record.requestedAt !== "number" || !Number.isFinite(record.requestedAt)) return null;
  return {
    type: record.type,
    source: record.source,
    itemId: record.itemId,
    requestedAt: record.requestedAt,
  };
}
