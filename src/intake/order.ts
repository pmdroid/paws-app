import type { DependencyEdge } from "../linear";

export type OrderNode = {
  linearIssueId: string;
  identifier: string;
  title: string;
};

export type OrderResult =
  | { ok: true; ordered: readonly OrderNode[] }
  | { ok: false; reason: "cycle"; remaining: readonly OrderNode[] };

/**
 * Blockers come first. Ties keep the original sub-issue order.
 * An edge whose ends are not both in `nodes` is ignored. A cycle orders nothing.
 */
export function orderByBlocks(
  nodes: readonly OrderNode[],
  edges: readonly DependencyEdge[],
): OrderResult {
  const ids = new Set(nodes.map((node) => node.linearIssueId));
  const index = new Map(nodes.map((node, position) => [node.linearIssueId, position]));
  const incoming = new Map<string, Set<string>>();
  for (const node of nodes) incoming.set(node.linearIssueId, new Set());
  for (const edge of edges) {
    if (!ids.has(edge.blockerLinearIssueId) || !ids.has(edge.blockedLinearIssueId)) continue;
    incoming.get(edge.blockedLinearIssueId)?.add(edge.blockerLinearIssueId);
  }
  const remaining = new Set(ids);
  const ordered: OrderNode[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => {
      const blockers = incoming.get(id);
      if (blockers === undefined) return false;
      for (const blocker of blockers) {
        if (remaining.has(blocker)) return false;
      }
      return true;
    });
    if (ready.length === 0) {
      return {
        ok: false,
        reason: "cycle",
        remaining: nodes.filter((node) => remaining.has(node.linearIssueId)),
      };
    }
    ready.sort((left, right) => (index.get(left) ?? 0) - (index.get(right) ?? 0));
    const next = ready[0];
    if (next === undefined) break;
    remaining.delete(next);
    const node = nodes.find((item) => item.linearIssueId === next);
    if (node !== undefined) ordered.push(node);
  }
  return { ok: true, ordered };
}
