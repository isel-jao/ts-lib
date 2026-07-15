/**
 * Inverts a dependency map: `deps.get(node)` lists the nodes `node` depends
 * on, and the result maps each node to the set of nodes that depend on it.
 * Every key of `deps` gets an entry (empty when nothing depends on it);
 * edges pointing to targets that are not keys of `deps` are ignored.
 */
export function reverseDependencies(
  deps: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const reversed = new Map<string, Set<string>>();

  for (const node of deps.keys()) {
    reversed.set(node, new Set());
  }

  for (const [node, targets] of deps) {
    for (const target of targets) {
      reversed.get(target)?.add(node);
    }
  }

  return reversed;
}
