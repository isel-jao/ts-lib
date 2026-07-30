# RingBuffer

A fixed-capacity circular buffer backed by a single pre-allocated array. Every mutation — `push`, `pop`, `shift`, `unshift`, `at` — is O(1), including insertion and removal at the front, and no allocation happens after construction. When the buffer is full, writes overwrite the element at the opposite end and return it, so eviction is observable instead of silent. Reach for it when you need a bounded window over a stream: the last N log lines, a rolling metric window, a replay/undo buffer, or a work deque with a hard memory ceiling.

## Why

The hand-written version of a bounded window looks harmless:

```ts
const recent: Event[] = [];

function record(e: Event) {
  recent.push(e);
  if (recent.length > 1000) recent.shift();
}
```

`Array.prototype.shift` is O(n). It removes index 0 and then re-indexes every remaining element down by one. Once the array is at its cap, *every* subsequent `record` call pays a 999-element move. Feed 100k events through a 1000-element window and you have done ~10^8 element copies to retain 1000 objects. The `slice` variant (`recent = recent.slice(-1000)`) is worse — it allocates a fresh 1000-element array per event and hands the old one to the GC.

Beyond the cost, the inline helper leaks details into every call site:

- The bounds check (`if (length > cap)`) has to be repeated everywhere the collection is written to, and it is off-by-one bait.
- The evicted element is thrown away. If it owned something — an open handle, an object URL, a term in a running sum — you have to remember to capture `recent.shift()`'s return value and to only call it in the overflow branch.
- Front insertion (`unshift`) is O(n) too, so a naive deque degrades the same way in the other direction.
- Peak memory is unbounded during the append: `push` can trigger a backing-store reallocation even though the logical size never exceeds the cap.

`RingBuffer` collapses all of that into one object with a fixed memory footprint: `capacity` slots, allocated once, reused forever. The capacity check lives in one place, eviction is returned to the caller rather than discarded, and both ends are symmetric and O(1).

## How it works

### Data layout

The class holds four pieces of state:

```ts
private buffer: (T | undefined)[];  // new Array(capacity), never resized
private count = 0;                  // number of live elements
private start = 0;                  // physical index of logical element 0
private end = 0;                    // physical index of the next push slot
```

`buffer` is allocated once in the constructor and never grows. Elements do not move; the *window* moves over them. Logical index `i` (0 = oldest) lives at physical index:

```
physical(i) = (start + i) % capacity
```

That single mapping is the whole data structure. `at`, `toArray`, and the iterator are all one-liners over it.

### Invariants

Three invariants hold after every public method returns:

1. `0 <= count <= capacity`
2. `end === (start + count) % capacity`
3. `start` and `end` are always in `[0, capacity)`

Invariant 2 is the load-bearing one, and it is why a full buffer has `start === end`: when `count === capacity`, `(start + capacity) % capacity === start`. That coincidence is what lets `push` read the element it is about to evict as `buffer[this.end]` without computing anything — when full, the next write slot *is* the oldest element.

Check that the writers preserve it. `push` (not full) does `count++` and `end++`: both sides of invariant 2 advance by one. `unshift` (not full) does `count++` and `start--`: `(start - 1) + (count + 1)` is unchanged, so `end` correctly stays put. `push` (full) advances `start` and `end` together with `count` pinned at `capacity`. Any change to this class has to keep that equation true.

### Buffer state, drawn

`capacity = 5`, after `push(a) push(b) push(c)`:

```
idx:   0    1    2    3    4
     [ a ][ b ][ c ][   ][   ]
       ^              ^
     start=0        end=3        count=3   (0 + 3 = 3)
```

After two more pushes it is full and `start === end`:

```
idx:   0    1    2    3    4
     [ a ][ b ][ c ][ d ][ e ]
       ^
   start=end=0                   count=5   (0 + 5 = 5 % 5 = 0)
```

`push(f)` now overwrites slot 0 — the oldest — returns `a`, and drags both cursors forward:

```
idx:   0    1    2    3    4
     [ f ][ b ][ c ][ d ][ e ]
            ^
        start=end=1              count=5
```

The physical order is `f b c d e`; the logical order that `toArray` and `for...of` produce is `b c d e f`. The buffer is "wrapped": logical index 0 is at physical 1, and logical index 4 is at physical `(1 + 4) % 5 = 0`.

### Why `(x - 1 + capacity) % capacity`

Backward cursor moves (`pop`, and the two cursor decrements in `unshift`) are written as:

```ts
this.end = (this.end - 1 + this.capacity) % this.capacity;
```

The `+ this.capacity` is not cosmetic. JavaScript's `%` is a *remainder*, not a mathematical modulo: its sign follows the dividend. With `capacity === 3` and `end === 0`, `(0 - 1) % 3` evaluates to `-1`, not `2`. Writing `-1` into `end` corrupts every subsequent `(start + i) % capacity` lookup and produces `undefined` reads. Adding `capacity` before the `%` shifts the dividend into non-negative territory first, where remainder and modulo agree.

One addition is sufficient, and cannot itself overflow the range: `x` is always in `[0, capacity)` by invariant 3, so `x - 1 + capacity` is in `[capacity - 1, 2 * capacity - 1)`, and a single `% capacity` brings it back into `[0, capacity)`. Forward moves (`x + 1`) never need the correction because the dividend is already non-negative.

### Why the writers return the overwritten element

`push` and `unshift` return `T | undefined`: the evicted element when the buffer was full, `undefined` otherwise. This is the only moment the buffer knows something is being dropped, and the caller usually needs to react:

```ts
const evicted = buffer.push(sample);
if (evicted !== undefined) sum -= evicted;   // O(1) sliding-window sum
sum += sample;
```

Without it, every call site would have to do `if (buffer.isFull) release(buffer.at(0))` *before* pushing — an extra branch, an extra read, and a correctness trap the moment someone reorders the two statements. Returning the value from inside the one place that already knows makes the eviction impossible to miss and free to ignore. The same applies to resource-owning payloads: revoke the object URL, close the handle, decrement the reference count.

Note the asymmetry: `push` evicts from the *front* (the oldest element, FIFO drop) and `unshift` evicts from the *back* (the newest element). Each write pushes something off the opposite end.

`unshift` on a full buffer is the subtlest method in the file. It decrements `end` first — which, because `start === end` when full, makes `end` name the slot holding the newest element — reads that value out as the return, and then decrements `start` to the *same* index and writes the new item there. Both cursors land together, so `start === end` still holds and the buffer stays full.

### Memory hygiene

`pop` and `shift` write `undefined` into the slot they vacate before decrementing `count`. Logically that is unnecessary — `count` alone already excludes the slot — but without it the backing array would keep a live reference to a removed element for as long as the buffer exists, which for a 10k-slot buffer of large objects is a real retention leak. `push`'s overwrite path does not need the same treatment because the slot is reassigned on the very next line. `clear()` goes further and allocates a fresh `new Array(capacity)`, dropping all references at once.

### Iteration

`[Symbol.iterator]` does not copy. It keeps a logical cursor `i` and yields `buffer[(start + i++) % capacity]` while `i < count`, so the physical wraparound is invisible and `[...rb]` always comes out in oldest-to-newest order regardless of where `start` happens to sit. `toArray` is the same walk into a new array.

The trade-off of not snapshotting: `this.count` and `this.start` are read on *each* `next()` call, so the iterator reflects live state. Mutating the buffer mid-iteration shifts what you see — consume one element, `shift()`, and the next `next()` skips an element, because the cursor advanced while `start` also moved. Materialize with `toArray()` first if you intend to mutate while looping.

### Complexity

| Operation | Time | Notes |
| --- | --- | --- |
| `push` / `unshift` | O(1) | vs. O(n) for `Array.prototype.unshift` |
| `pop` / `shift` | O(1) | vs. O(n) for `Array.prototype.shift` |
| `at` / `size` / `isFull` / `isEmpty` | O(1) | |
| `toArray` / iteration | O(n) in `size` | one allocation for `toArray`, none for iteration |
| `clear` | O(capacity) | allocates a replacement array |
| Space | O(capacity) | fixed at construction; independent of `size` |

## API

### `new RingBuffer<T>(capacity: number)`

Creates an empty buffer with room for exactly `capacity` elements.

- `capacity` — the maximum number of elements. Must be a positive integer.

Throws `Error("Capacity must be > 0")` when `capacity <= 0`. Non-integer, `NaN`, and `Infinity` capacities are not caught by that check but fail in `new Array(capacity)` with a `RangeError: Invalid array length`.

### `capacity: number`

Public instance field holding the configured capacity. Read it freely; it is not readonly, but assigning to it does **not** resize the backing array and will break the modular arithmetic. Treat it as read-only.

### `get size(): number`

Number of elements currently held. Always in `[0, capacity]`.

### `get isFull(): boolean`

`true` when `size === capacity`. The next `push` or `unshift` will evict.

### `get isEmpty(): boolean`

`true` when `size === 0`.

### `push(item: T): T | undefined`

Appends `item` at the back (newest end).

- Returns `undefined` if there was free space.
- Returns the **evicted oldest element** if the buffer was full. `size` stays at `capacity`.

Never throws.

### `pop(): T | undefined`

Removes and returns the newest element (LIFO). Returns `undefined` if the buffer is empty. Never throws.

### `unshift(item: T): T | undefined`

Prepends `item` at the front (oldest end).

- Returns `undefined` if there was free space.
- Returns the **evicted newest element** if the buffer was full. `size` stays at `capacity`.

Never throws.

### `shift(): T | undefined`

Removes and returns the oldest element (FIFO). Returns `undefined` if the buffer is empty. Never throws.

### `at(index: number): T | undefined`

Reads by logical position without removing.

- `index` — `0` is the oldest element, `size - 1` the newest. Negative values count back from the end (`-1` is the newest), matching `Array.prototype.at`.
- Returns `undefined` when the resolved index falls outside `[0, size)`.

Never throws.

### `clear(): void`

Resets to empty and releases every held reference by replacing the backing array. `capacity` is unchanged and the instance is immediately reusable.

### `toArray(): T[]`

Returns a new plain array of the live elements in oldest-to-newest order. The buffer is unmodified. Element references are shared, not cloned.

### `[Symbol.iterator](): Iterator<T>`

Makes the buffer iterable in oldest-to-newest order, so `for...of`, spread, `Array.from`, and destructuring all work. Yields exactly `size` values. Reads live state on each step — see [Iteration](#iteration).

## Usage

Bounded log window with eviction handling:

```ts
import { RingBuffer } from "@isel-jao/ts-lib";

const recent = new RingBuffer<string>(1000);

function log(line: string) {
  const dropped = recent.push(line);
  if (dropped !== undefined) {
    metrics.increment("log.dropped");
  }
}

// Newest 10 lines, newest first.
const tail = recent.toArray().slice(-10).reverse();
```

Double-ended queue — both ends are O(1):

```ts
import { RingBuffer } from "@isel-jao/ts-lib";

const deque = new RingBuffer<Task>(64);

deque.push(lowPriority);      // back
deque.unshift(urgent);        // front

const next = deque.shift();   // oldest / highest priority
const newest = deque.pop();   // most recently appended
```

O(1) rolling average — the non-trivial case. The evicted element returned by `push` is exactly the term that must leave the running sum, so the window never has to be re-summed:

```ts
import { RingBuffer } from "@isel-jao/ts-lib";

class RollingMean {
  private readonly window: RingBuffer<number>;
  private sum = 0;

  constructor(size: number) {
    this.window = new RingBuffer<number>(size);
  }

  add(value: number): number {
    const evicted = this.window.push(value);
    if (evicted !== undefined) this.sum -= evicted;
    this.sum += value;
    return this.sum / this.window.size;
  }
}

const mean = new RollingMean(3);
mean.add(10); // 10
mean.add(20); // 15
mean.add(30); // 20
mean.add(60); // 36.666… — the 10 was evicted and subtracted
```

Iteration and indexed access stay in logical order across wraparound:

```ts
import { RingBuffer } from "@isel-jao/ts-lib";

const rb = new RingBuffer<number>(3);
rb.push(1);
rb.push(2);
rb.push(3);
rb.push(4); // evicts 1, buffer is now wrapped

[...rb];        // [2, 3, 4]
rb.at(0);       // 2  (oldest)
rb.at(-1);      // 4  (newest)
Array.from(rb); // [2, 3, 4]
```

## Edge cases

| Case | Behavior |
| --- | --- |
| `new RingBuffer(0)` / `new RingBuffer(-1)` | Throws `Error("Capacity must be > 0")` |
| `new RingBuffer(2.5)` / `NaN` / `Infinity` | Throws `RangeError: Invalid array length` from `new Array` — the guard only rejects `<= 0` |
| `capacity === 1` | Fully supported. Every `push`/`unshift` past the first evicts and returns the single held element |
| `push` on a full buffer | Overwrites the oldest; returns it; `size` stays at `capacity` |
| `unshift` on a full buffer | Overwrites the **newest**; returns it; `size` stays at `capacity` |
| `push` / `unshift` with space free | Returns `undefined` |
| `pop` / `shift` on an empty buffer | Returns `undefined` — no throw, no `size` change |
| `at(index)` with `index >= size` | `undefined` (e.g. `at(5)` on a buffer of 1) |
| `at(-n)` where `n > size` | `undefined`; `at(-size)` is the oldest element |
| `at(0)` on an empty buffer | `undefined` |
| Fractional `index` in `at` | `undefined` — it passes the bounds check but resolves to a non-integer slot |
| Storing `undefined` as a value | Allowed and counted in `size`, but indistinguishable from "absent" by return value alone — check `size` / `isEmpty` |
| `toArray()` / `[...rb]` on an empty buffer | `[]` |
| `clear()` then reuse | `size` is 0, `toArray()` is `[]`, and subsequent pushes behave as on a fresh instance |
| `unshift` after a `shift` (wrapped state) | Correct logical order preserved — e.g. `push 1,2,3` → `shift()` → `unshift(0)` yields `[0, 2, 3]` |
| Mutating during `for...of` | The iterator reads live `start`/`count`; elements can be skipped. Iterate `toArray()` instead |
| Reassigning `rb.capacity` | Not guarded. Corrupts the cursor arithmetic — do not do it |
