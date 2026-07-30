# reverseDependencies

Inverts a dependency graph. Given a map of "what each node depends on", it returns a map of "what depends on each node" — every key of the input gets an entry in the output, empty when nothing depends on it.

Reach for it whenever a change to one node has to propagate outward: cache invalidation, incremental rebuilds, "what breaks if I delete this", reactive recomputation, impact analysis on a schema or module graph.

## Why

Dependency data is almost always *stored* in the forward direction, because that is how it is authored. A `package.json` lists what it needs. An import statement names the module being imported. A memoized cell records the cells it read. The edge is written down at the dependent end.

But the questions you actually ask at runtime run the other way:

- A file changed — which caches are now stale?
- A package was published — which workspaces must rebuild?
- This table is being dropped — what queries break?

Answering those from the forward map means a full scan per query: `[...deps].filter(([, targets]) => targets.has(x))`. That is O(V + E) *per lookup*, and traversing the transitive blast radius does one such scan per visited node, turning an O(V + E) walk into O(V·(V + E)). Inverting once and reusing the result makes every lookup O(1).

The five-line inline version people write is:

```ts
const rev = new Map<string, Set<string>>();
for (const [node, targets] of deps) {
  for (const target of targets) {
    (rev.get(target) ?? rev.set(target, new Set()).get(target)!).add(node);
  }
}
```

It has two bugs that only show up later:

1. **Leaf nodes vanish.** Entries are created lazily, only when something points at them. A node nothing depends on never becomes a key, so `rev.get("app")` is `undefined` rather than an empty set — and every call site now needs `?? new Set()`, or crashes on the one node that happens to be at the top of the tree. `reverseDependencies` pre-seeds all keys, so the output key set is exactly the input key set.
2. **Dangling edges create phantom nodes.** If `a` depends on `"ghost"` and `ghost` is not a node in your graph, the lazy version invents a `ghost` key in the output. Now the reversed graph has a node the forward graph does not, and anything iterating both — a topological sort, a diff, a render — is off by one node. `reverseDependencies` drops edges whose target is not a key.

## How it works

Two passes, no recursion.

**Pass 1 — seed.** Every key of `deps` gets an empty `Set` in the output:

```ts
for (const node of deps.keys()) {
  reversed.set(node, new Set());
}
```

This single loop is what gives the function its two structural guarantees: the output has exactly the same key set as the input, and pass 2 needs no "create if missing" logic.

**Pass 2 — flip each edge.** For every edge `node -> target` (meaning "node depends on target"), record `node` in the bucket of `target`:

```ts
for (const [node, targets] of deps) {
  for (const target of targets) {
    reversed.get(target)?.add(node);
  }
}
```

The `?.` is load-bearing, not defensive noise. `reversed.get(target)` is `undefined` exactly when `target` is not a key of `deps` — a dangling edge — and the optional call makes that edge silently disappear instead of materialising a phantom node. It is the only branch in the function, and it is the whole out-of-graph policy.

Because the buckets are `Set`s, parallel edges collapse: if `deps` were built from a list that mentioned the same dependency twice, the dependent still appears once in the result.

**Invariants.**

- `[...result.keys()]` equals `[...deps.keys()]`, same membership, same insertion order.
- `result.get(y).has(x)` iff `deps.get(x).has(y)` **and** `y` is a key of `deps`.
- The input is never touched — new `Map`, new `Set`s, no aliasing of the input sets. The tests assert this explicitly.
- Self-loops are preserved: `a -> a` inverts to `a -> a`.
- Cycles are preserved as cycles (a 2-cycle inverts to a 2-cycle with the direction flipped, which for a 2-cycle is the same set of edges).

**Round-tripping.** `reverseDependencies(reverseDependencies(g)) === g` holds for *closed* graphs — every edge target is also a key. That is the property the test suite checks, and it is what tells you the inversion is lossless. It does **not** hold when the graph has dangling edges, because the first inversion drops them: `{ a: ["ghost"], b: ["a"] }` inverts to `{ a: ["b"], b: [] }`, and inverting that gives `{ a: [], b: ["a"] }` — the ghost edge is gone for good. If you need round-tripping, close the graph first (add every referenced id as a key).

**Complexity.** O(V + E) time — one pass over keys, one pass over edges, all `Map`/`Set` operations amortised O(1). O(V + E) space for the new map and sets. Inversion is strictly cheaper than one forward scan per query as soon as you have more than one query.

**Types.** The parameter and return type are `ReadonlyMap<string, ReadonlySet<string>>`. Readonly is compile-time only — the returned object is a genuine `Map` of genuine `Set`s, and casting it back to a mutable type will let you corrupt it. The `ReadonlyMap` parameter type is the useful half: it lets you pass a `Map<string, Set<string>>` in without a cast while proving at the type level that the function cannot write to it.

This inversion is the same structure [`topoSort`](../topo-sort/README.md) builds internally as its `dependents` map — Kahn's algorithm has to walk edges in the "unblocks" direction while the input describes the "depends on" direction. If you already hold a reversed graph and also want an ordering, the two are natural companions; see the combined example below.

## API

### `reverseDependencies`

```ts
function reverseDependencies(
  deps: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlyMap<string, ReadonlySet<string>>;
```

- `deps` — forward dependency graph. `deps.get(x)` is the set of nodes `x` depends on. The key set defines the graph's node set; edge targets that are not keys are ignored. Not mutated.

Returns a new map with the same keys, where `result.get(y)` is the set of nodes that depend on `y`. Nodes nothing depends on map to an empty set. Never throws.

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
dependents.get("ui"); // Set { "app" }
dependents.get("app"); // Set {} — nothing depends on it
```

Transitive cache invalidation — the reason this function exists. One inversion, then a BFS gives the full blast radius:

```ts
import { reverseDependencies } from "@isel-jao/ts-lib";

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

Hoist the inversion out of the loop if you invalidate repeatedly — it is the expensive half, and it only changes when the graph does:

```ts
const dependents = reverseDependencies(graph); // once
for (const changedFile of watcher.changes) {
  invalidate(dependents.get(changedFile) ?? new Set());
}
```

## Edge cases

| Input | Result | Source |
| --- | --- | --- |
| Empty map | empty map | test |
| Nodes with no dependencies (`{ a: [], b: [] }`) | `{ a: [], b: [] }` — keys preserved, sets empty | test |
| Shared dependency (`b: [a]`, `c: [a]`) | `a` maps to `{ b, c }` | test |
| Self-dependency (`a: [a]`) | preserved as `a: [a]` | test |
| 2-cycle (`a: [b]`, `b: [a]`) | preserved as a 2-cycle | test |
| Edge to a non-key (`a: ["ghost"]`) | dropped; no `ghost` key in the output | test |
| Input map / input sets | never mutated | test |
| Double inversion on a closed graph | returns the original graph | test |
| Double inversion on a graph with dangling edges | loses the dangling edges — not a round trip | code |
| Duplicate edges | impossible — input targets are already `Set`s, output buckets are `Set`s | code |
