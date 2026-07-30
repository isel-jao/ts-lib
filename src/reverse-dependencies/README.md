# reverseDependencies

Inverts a dependency graph. Given a map of "what each node depends on", it returns a map of "what depends on each node" — every key of the input gets an entry in the output, empty when nothing depends on it.

Reach for it whenever a change to one node has to propagate outward: cache invalidation, incremental rebuilds, "what breaks if I delete this", reactive recomputation.

## Why

Dependency data is almost always *stored* in the forward direction, because that is how it is authored — a `package.json` lists what it needs, an import statement names the module being imported, a memoized cell records the cells it read. The edge is written down at the dependent end.

The questions you ask at runtime run the other way: a file changed, so which caches are stale? Answering that from the forward map means a full scan per query — O(V + E) *per lookup*, and walking the transitive blast radius does one scan per visited node, turning an O(V + E) traversal into O(V·(V + E)). Inverting once makes every lookup O(1).

The inline version people write has two bugs that surface late:

1. **Leaf nodes vanish.** Entries created lazily only exist once something points at them, so a node nothing depends on never becomes a key. `rev.get("app")` is `undefined` instead of an empty set, and every call site needs `?? new Set()` or crashes on whichever node sits at the top of the tree.
2. **Dangling edges create phantom nodes.** If `a` depends on `"ghost"` and `ghost` is not a node in your graph, the lazy version invents a `ghost` key. The reversed graph now has a node the forward graph does not, and anything iterating both is off by one.

## How it works

Two passes, no recursion.

**Pass 1 — seed.** Every key of `deps` gets an empty `Set`. This one loop provides both structural guarantees: the output key set is exactly the input key set, and pass 2 needs no create-if-missing logic.

**Pass 2 — flip each edge.** For every edge `node -> target`, record `node` in the bucket of `target`:

```ts
for (const [node, targets] of deps) {
  for (const target of targets) {
    reversed.get(target)?.add(node);
  }
}
```

The `?.` is load-bearing, not defensive noise. `reversed.get(target)` is `undefined` exactly when `target` is not a key of `deps` — a dangling edge — so the optional call makes that edge disappear instead of materializing a phantom node. It is the only branch in the function and it is the entire out-of-graph policy.

**Invariants.**

- `[...result.keys()]` equals `[...deps.keys()]` — same membership, same insertion order.
- `result.get(y).has(x)` iff `deps.get(x).has(y)` **and** `y` is a key of `deps`.
- The input is never touched: new `Map`, new `Set`s, no aliasing. Asserted by the tests.
- Self-loops and cycles are preserved.

**Round-tripping.** Double inversion returns the original for *closed* graphs — every edge target is also a key — which is what tells you the inversion is lossless. It does **not** hold with dangling edges, since the first pass drops them: `{ a: ["ghost"], b: ["a"] }` inverts to `{ a: ["b"], b: [] }`, and inverting that gives `{ a: [], b: ["a"] }`. Close the graph first if you need the round trip.

**Complexity.** O(V + E) time and space, all `Map`/`Set` operations amortized O(1). Inversion beats one forward scan per query as soon as you have more than one query.

The parameter and return types are `ReadonlyMap<string, ReadonlySet<string>>`. Readonly is compile-time only — the result is a genuine `Map` of genuine `Set`s. The `ReadonlyMap` parameter is the useful half: it accepts a mutable map without a cast while proving the function cannot write to it.

This is the same inversion [`topoSort`](../topo-sort/README.md) builds internally as its `dependents` map, since Kahn's algorithm walks edges in the "unblocks" direction while the input describes "depends on".

## API

### `reverseDependencies`

```ts
function reverseDependencies(
  deps: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlyMap<string, ReadonlySet<string>>;
```

- `deps` — forward graph. `deps.get(x)` is the set of nodes `x` depends on. The key set defines the node set; edge targets that are not keys are ignored. Not mutated.

Returns a new map with the same keys, where `result.get(y)` is the set of nodes that depend on `y`. Never throws.

## Usage

```ts
import { reverseDependencies } from "@isel-jao/ts-lib";

const deps = new Map([
  ["core", new Set<string>()],
  ["ui", new Set(["core"])],
  ["app", new Set(["ui", "core"])],
]);

const dependents = reverseDependencies(deps);
dependents.get("core"); // Set { "ui", "app" }
dependents.get("app");  // Set {} — nothing depends on it
```

Transitive invalidation — one inversion, then a BFS gives the full blast radius. Hoist the inversion out of any loop; it is the expensive half and only changes when the graph does.

```ts
function blastRadius(
  deps: ReadonlyMap<string, ReadonlySet<string>>,
  changed: string
): Set<string> {
  const dependents = reverseDependencies(deps);
  const affected = new Set<string>([changed]);
  const queue = [changed];

  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    for (const dependent of dependents.get(node) ?? []) {
      if (affected.has(dependent)) continue; // also terminates on cycles
      affected.add(dependent);
      queue.push(dependent);
    }
  }

  return affected;
}

const graph = new Map([
  ["schema", new Set<string>()],
  ["model", new Set(["schema"])],
  ["api", new Set(["model"])],
  ["cli", new Set(["schema"])],
  ["unrelated", new Set<string>()],
]);

blastRadius(graph, "schema"); // Set { "schema", "model", "cli", "api" }
```

## Edge cases

| Input | Result |
| --- | --- |
| Empty map | empty map |
| Nodes with no dependencies | keys preserved, sets empty |
| Shared dependency (`b: [a]`, `c: [a]`) | `a` maps to `{ b, c }` |
| Self-dependency (`a: [a]`) | preserved |
| 2-cycle (`a: [b]`, `b: [a]`) | preserved as a 2-cycle |
| Edge to a non-key (`a: ["ghost"]`) | dropped; no `ghost` key in the output |
| Input map and sets | never mutated |
| Double inversion, closed graph | returns the original |
| Double inversion, dangling edges | loses them — not a round trip |
