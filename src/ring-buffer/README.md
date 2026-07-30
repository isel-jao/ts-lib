# RingBuffer

A fixed-capacity circular buffer backed by a single pre-allocated array. Every mutation — `push`, `pop`, `shift`, `unshift`, `at` — is O(1), including at the front, and no allocation happens after construction. When full, writes overwrite the element at the opposite end and return it, so eviction is observable instead of silent. Reach for it when you need a bounded window over a stream: the last N log lines, a rolling metric window, a replay/undo buffer, or a work deque with a hard memory ceiling.

## Why

The hand-written bounded window looks harmless:

```ts
recent.push(e);
if (recent.length > 1000) recent.shift();
```

`Array.prototype.shift` is O(n) — it removes index 0 and re-indexes every remaining element down by one. Once the array is at its cap, *every* subsequent call pays a 999-element move: feed 100k events through a 1000-element window and you have done ~10⁸ element copies to retain 1000 objects. The `slice` variant (`recent = recent.slice(-1000)`) is worse, allocating a fresh 1000-element array per event and handing the old one to the GC.

Beyond cost, the inline helper leaks details into every call site. The bounds check has to be repeated everywhere the collection is written and is off-by-one bait. The evicted element is thrown away, so if it owned something — an open handle, an object URL, a term in a running sum — you must remember to capture `shift()`'s return *and* only call it in the overflow branch. Front insertion is O(n) too, so a naive deque degrades the same way in the other direction. And peak memory is unbounded during the append, since `push` can trigger a backing-store reallocation even though the logical size never exceeds the cap.

`RingBuffer` collapses that into one object with a fixed footprint: `capacity` slots, allocated once, reused forever. The capacity check lives in one place, eviction is returned rather than discarded, and both ends are symmetric and O(1).

## How it works

### Data layout

```ts
private buffer: (T | undefined)[];  // new Array(capacity), never resized
private count = 0;                  // number of live elements
private start = 0;                  // physical index of logical element 0
private end = 0;                    // physical index of the next push slot
```

`buffer` is allocated once and never grows. Elements do not move; the *window* moves over them. Logical index `i` (0 = oldest) lives at physical index `(start + i) % capacity`. That single mapping is the whole data structure — `at`, `toArray`, and the iterator are all one-liners over it.

### Invariants

Three hold after every public method returns:

1. `0 <= count <= capacity`
2. `end === (start + count) % capacity`
3. `start` and `end` are always in `[0, capacity)`

Invariant 2 is load-bearing, and it is why a full buffer has `start === end`: when `count === capacity`, `(start + capacity) % capacity === start`. That coincidence lets `push` read the element it is about to evict as `buffer[this.end]` without computing anything — when full, the next write slot *is* the oldest element.

The writers preserve it. `push` (not full) does `count++` and `end++`, advancing both sides by one. `unshift` (not full) does `count++` and `start--`, leaving `(start - 1) + (count + 1)` unchanged so `end` correctly stays put. `push` (full) advances `start` and `end` together with `count` pinned at `capacity`. Any change to this class has to keep that equation true.

### Buffer state, drawn

`capacity = 5`, after `push(a) push(b) push(c)`; then full, where `start === end`; then after `push(f)` overwrites slot 0, returns `a`, and drags both cursors forward:

```
idx:   0    1    2    3    4          0    1    2    3    4          0    1    2    3    4
     [ a ][ b ][ c ][   ][   ]      [ a ][ b ][ c ][ d ][ e ]      [ f ][ b ][ c ][ d ][ e ]
       ^              ^               ^                                  ^
     start=0        end=3           start=end=0                      start=end=1
     count=3  (0 + 3 = 3)           count=5  (0 + 5 = 5 % 5 = 0)    count=5
```

The physical order is now `f b c d e`; the logical order `toArray` and `for...of` produce is `b c d e f`. The buffer is "wrapped" — logical index 0 sits at physical 1, and logical index 4 at physical `(1 + 4) % 5 = 0`.

### Why `(x - 1 + capacity) % capacity`

Backward cursor moves (`pop`, and the two decrements in `unshift`) are written `this.end = (this.end - 1 + this.capacity) % this.capacity`. The `+ capacity` is not cosmetic: JavaScript's `%` is a *remainder*, not a mathematical modulo, and its sign follows the dividend. With `capacity === 3` and `end === 0`, `(0 - 1) % 3` is `-1`, not `2`. Writing `-1` into `end` corrupts every subsequent `(start + i) % capacity` lookup and produces `undefined` reads. Adding `capacity` first shifts the dividend into non-negative territory, where remainder and modulo agree.

One addition suffices and cannot overflow the range: `x` is in `[0, capacity)` by invariant 3, so `x - 1 + capacity` is in `[capacity - 1, 2 * capacity - 1)`, and a single `% capacity` brings it back. Forward moves never need the correction, their dividend already being non-negative.

### Why the writers return the overwritten element

`push` and `unshift` return the evicted element when the buffer was full, `undefined` otherwise. This is the only moment the buffer knows something is being dropped, and the caller usually needs to react:

```ts
const evicted = buffer.push(sample);
if (evicted !== undefined) sum -= evicted;   // O(1) sliding-window sum
sum += sample;
```

Without it every call site would do `if (buffer.isFull) release(buffer.at(0))` *before* pushing — an extra branch, an extra read, and a correctness trap the moment someone reorders the two statements. Returning the value from the one place that already knows makes eviction impossible to miss and free to ignore. The same applies to resource-owning payloads: revoke the object URL, close the handle, decrement the refcount.

Note the asymmetry: `push` evicts from the *front* (oldest, a FIFO drop) and `unshift` from the *back* (newest). Each write pushes something off the opposite end.

`unshift` on a full buffer is the subtlest method in the file. It decrements `end` first — which, because `start === end` when full, makes `end` name the slot holding the newest element — reads that value out as the return, then decrements `start` to the *same* index and writes the new item there. Both cursors land together, so `start === end` still holds and the buffer stays full.

### Memory hygiene and iteration

`pop` and `shift` write `undefined` into the vacated slot before decrementing `count`. Logically that is unnecessary, since `count` alone already excludes the slot, but without it the backing array keeps a live reference to a removed element for as long as the buffer exists — a real retention leak for a 10k-slot buffer of large objects. `push`'s overwrite path needs no such treatment because the slot is reassigned on the next line. `clear()` goes further and allocates a fresh `new Array(capacity)`, dropping all references at once.

`[Symbol.iterator]` does not copy: it keeps a logical cursor `i` and yields `buffer[(start + i++) % capacity]` while `i < count`, so wraparound is invisible and `[...rb]` always comes out oldest-to-newest regardless of where `start` sits. `toArray` is the same walk into a new array. The trade-off of not snapshotting is that `count` and `start` are read on *each* `next()`, so the iterator reflects live state — consume one element, `shift()`, and the next `next()` skips one, because the cursor advanced while `start` also moved. Materialize with `toArray()` first if you intend to mutate while looping.

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

Creates an empty buffer with room for exactly `capacity` elements, which must be a positive integer. Throws `Error("Capacity must be > 0")` when `capacity <= 0`. Non-integer, `NaN`, and `Infinity` capacities are *not* caught by that check and fail instead in `new Array(capacity)` with `RangeError: Invalid array length`.

| Member | Returns | Behavior |
| --- | --- | --- |
| `capacity: number` | `number` | Public instance field holding the configured capacity. Not `readonly`, but assigning to it does **not** resize the backing array and breaks the modular arithmetic. Treat as read-only. |
| `get size()` | `number` | Elements currently held, always in `[0, capacity]`. |
| `get isFull()` | `boolean` | `size === capacity` — the next write will evict. |
| `get isEmpty()` | `boolean` | `size === 0`. |
| `push(item: T)` | `T \| undefined` | Appends at the back. Returns the **evicted oldest element** if full (`size` stays at `capacity`), `undefined` if there was space. |
| `pop()` | `T \| undefined` | Removes and returns the newest element (LIFO). `undefined` when empty. |
| `unshift(item: T)` | `T \| undefined` | Prepends at the front. Returns the **evicted newest element** if full, `undefined` if there was space. |
| `shift()` | `T \| undefined` | Removes and returns the oldest element (FIFO). `undefined` when empty. |
| `at(index: number)` | `T \| undefined` | Reads by logical position without removing. `0` is oldest, `size - 1` newest; negatives count back from the end (`-1` is newest), matching `Array.prototype.at`. `undefined` when the resolved index falls outside `[0, size)`. |
| `clear()` | `void` | Resets to empty and releases every held reference by replacing the backing array. `capacity` unchanged, instance immediately reusable. |
| `toArray()` | `T[]` | New plain array of live elements, oldest-to-newest. Buffer unmodified; element references shared, not cloned. |
| `[Symbol.iterator]()` | `Iterator<T>` | Iterable oldest-to-newest, so `for...of`, spread, `Array.from` and destructuring all work. Yields exactly `size` values, reading live state on each step. |

No method throws.

## Usage

Bounded log window with eviction handling, and a deque where both ends are O(1):

```ts
import { RingBuffer } from "@isel-jao/ts-lib";

const recent = new RingBuffer<string>(1000);
const dropped = recent.push(line);
if (dropped !== undefined) metrics.increment("log.dropped");

const tail = recent.toArray().slice(-10).reverse(); // newest 10, newest first

const deque = new RingBuffer<Task>(64);
deque.push(lowPriority);    // back
deque.unshift(urgent);      // front
deque.shift();              // oldest / highest priority
deque.pop();                // most recently appended
```

An O(1) rolling average — the evicted element returned by `push` is exactly the term that must leave the running sum, so the window is never re-summed:

```ts
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
const rb = new RingBuffer<number>(3);
rb.push(1); rb.push(2); rb.push(3);
rb.push(4);     // evicts 1, buffer is now wrapped

[...rb];        // [2, 3, 4]
rb.at(0);       // 2  (oldest)
rb.at(-1);      // 4  (newest)
```

## Edge cases

| Case | Behavior |
| --- | --- |
| `new RingBuffer(0)` / `new RingBuffer(-1)` | Throws `Error("Capacity must be > 0")` |
| `new RingBuffer(2.5)` / `NaN` / `Infinity` | Throws `RangeError: Invalid array length` from `new Array` — the guard only rejects `<= 0` |
| `capacity === 1` | Fully supported. Every write past the first evicts and returns the single held element |
| `push` on a full buffer | Overwrites the oldest; returns it; `size` stays at `capacity` |
| `unshift` on a full buffer | Overwrites the **newest**; returns it; `size` stays at `capacity` |
| `push` / `unshift` with space free | Returns `undefined` |
| `pop` / `shift` on an empty buffer | Returns `undefined` — no throw, no `size` change |
| `at(index)` with `index >= size` | `undefined` (e.g. `at(5)` on a buffer of 1) |
| `at(-n)` where `n > size` | `undefined`; `at(-size)` is the oldest element |
| `at(0)` on an empty buffer | `undefined` |
| Fractional `index` in `at` | `undefined` — passes the bounds check but resolves to a non-integer slot |
| Storing `undefined` as a value | Allowed and counted in `size`, but indistinguishable from "absent" by return value alone — check `size` / `isEmpty` |
| `toArray()` / `[...rb]` on an empty buffer | `[]` |
| `clear()` then reuse | `size` is 0, `toArray()` is `[]`, subsequent pushes behave as on a fresh instance |
| `unshift` after a `shift` (wrapped state) | Correct logical order preserved — `push 1,2,3` → `shift()` → `unshift(0)` yields `[0, 2, 3]` |
| Mutating during `for...of` | The iterator reads live `start`/`count`; elements can be skipped. Iterate `toArray()` instead |
| Reassigning `rb.capacity` | Not guarded. Corrupts the cursor arithmetic — do not do it |
