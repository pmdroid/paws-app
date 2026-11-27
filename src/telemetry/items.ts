import type { CommittedTransition } from "../db";
import type { Telemetry } from "./telemetry";
import type { TelemetrySettings } from "./settings";

const SCOPES: Record<TelemetrySettings["items"]["scope"], readonly string[] | null> = {
  all: null,
  final: ["merged", "completed", "cancelled", "failed"],
  failures_and_questions: ["failed", "awaiting_input"],
};

export function itemTransitionLogs(telemetry: Telemetry) {
  return (transition: CommittedTransition): void => {
    const settings = telemetry.settings();
    if (!settings.enabled || !settings.items.enabled) return;
    const states = SCOPES[settings.items.scope];
    if (states !== null && !states.includes(transition.to)) return;
    const where = settings.items.includeRepositoryAndRunner;
    telemetry.logs.emit({
      body: "paws.item.transition",
      attributes: {
        "event.name": "paws.item.transition",
        "paws.issue": transition.issue,
        "paws.item_id": transition.itemId,
        "paws.from": transition.from,
        "paws.event": transition.event,
        "paws.to": transition.to,
        "paws.version": transition.version,
        ...(where && transition.repository !== null
          ? { "paws.repository": transition.repository }
          : {}),
        ...(where && transition.runnerId !== null ? { "paws.runner_id": transition.runnerId } : {}),
      },
    });
  };
}
