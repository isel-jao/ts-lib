export interface TopoSortResult {
  /** Nodes with no cyclic dependency, in a valid dependency-respecting order. */
  readonly order: string[];
  /** Nodes that are part of a dependency cycle (a self-dependency counts as a 1-cycle). */
  readonly cyclic: Set<string>;
}

/**
 * Kahn's algorithm. `deps[node]` lists the nodes `node` depends on; edges
 * pointing outside `nodes` are ignored. Traversal order is deterministic:
 * ties are broken by the order nodes appear in `nodes`. Any node left over
 * once no more zero-indegree nodes remain is part of a cycle.
 */
export function topoSort(
  nodes: string[],
  deps: Record<string, string[]>,
): TopoSortResult {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    indegree.set(node, 0);
    dependents.set(node, []);
  }

  for (const node of nodes) {
    for (const dep of deps[node] ?? []) {
      if (!indegree.has(dep)) continue;
      indegree.set(node, (indegree.get(node) ?? 0) + 1);
      dependents.get(dep)?.push(node);
    }
  }

  const queue = nodes.filter((node) => indegree.get(node) === 0);
  const order: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const dependent of dependents.get(node) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }

  const ordered = new Set(order);
  const cyclic = new Set(nodes.filter((node) => !ordered.has(node)));

  return { order, cyclic };
}
