/** A model choice an agent advertises, as its session config option lists it. */
export type ModelChoice = { id: string; name: string; description?: string };

const ONE_MILLION_ID = /\[1m\]$/i;
const ONE_MILLION_TEXT = /\s*\(1M context\)/i;
const ONE_MILLION_LABEL = " · 1M context";

/** True when the choice is a model's 1M context window rather than its standard one. */
export function isOneMillionModel(model: ModelChoice): boolean {
  return (
    ONE_MILLION_ID.test(model.id) ||
    ONE_MILLION_TEXT.test(model.name) ||
    ONE_MILLION_TEXT.test(model.description ?? "")
  );
}

/** The standard-window id of a `[1m]` entry, or null when the id has no `[1m]` suffix. */
export function standardModelId(id: string): string | null {
  return ONE_MILLION_ID.test(id) ? id.replace(ONE_MILLION_ID, "") : null;
}

/**
 * The name Paws shows for a model, such as "Opus 5.5 · 1M context". A 1M entry borrows its
 * standard sibling's name when the list has one, because the agent often names it only "Opus".
 */
export function modelLabel(model: ModelChoice, models: readonly ModelChoice[] = []): string {
  if (!isOneMillionModel(model)) return model.name;
  const standard = standardModelId(model.id);
  const sibling = models.find((entry) => entry.id === standard && !isOneMillionModel(entry));
  const base = (sibling?.name ?? model.name).replace(ONE_MILLION_TEXT, "").trim() || model.id;
  return base.endsWith(ONE_MILLION_LABEL) ? base : `${base}${ONE_MILLION_LABEL}`;
}
