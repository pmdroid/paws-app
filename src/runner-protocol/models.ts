type ModelChoice = { id: string; name: string; description?: string };

const LONG_CONTEXT = /\s*\(1M context\)\s*/i;

/** True when an agent's model entry is a 1M context window variant. */
export function longContextModel(model: ModelChoice): boolean {
  return (
    model.id.toLowerCase().endsWith("[1m]") ||
    LONG_CONTEXT.test(model.name) ||
    LONG_CONTEXT.test(model.description ?? "")
  );
}

/**
 * Labels each entry for people. A 1M entry reads "<model> · 1M context", named after its
 * standard entry when the agent lists one, so "opus[1m]" reads "Opus 5.5 · 1M context".
 */
export function labelModels<T extends ModelChoice>(
  models: readonly T[],
): Array<T & { longContext: boolean }> {
  return models.map((model) => {
    if (!longContextModel(model)) return { ...model, longContext: false };
    const id = model.id.replace(/\[1m\]$/i, "");
    const standard = models.find(
      (entry) => entry.id !== model.id && entry.id === id && !longContextModel(entry),
    );
    const name = standard?.name ?? (model.name.replace(LONG_CONTEXT, " ").trim() || id);
    return { ...model, name: `${name} · 1M context`, longContext: true };
  });
}
