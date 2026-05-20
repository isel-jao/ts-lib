export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private count = 0;
  private start = 0;
  private end = 0;

  constructor(public capacity: number) {
    if (capacity <= 0) {
      throw new Error("Capacity must be > 0");
    }
    this.buffer = new Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  get isFull(): boolean {
    return this.count === this.capacity;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  push(item: T): T | undefined {
    let overwritten: T | undefined;
    if (this.isFull) {
      overwritten = this.buffer[this.end] as T;
      this.start = (this.start + 1) % this.capacity;
    } else {
      this.count++;
    }
    this.buffer[this.end] = item;
    this.end = (this.end + 1) % this.capacity;
    return overwritten;
  }

  pop(): T | undefined {
    if (this.isEmpty) return undefined;
    this.end = (this.end - 1 + this.capacity) % this.capacity;
    const item = this.buffer[this.end] as T;
    this.buffer[this.end] = undefined;
    this.count--;
    return item;
  }

  unshift(item: T): T | undefined {
    let overwritten: T | undefined;
    if (this.isFull) {
      this.end = (this.end - 1 + this.capacity) % this.capacity;
      overwritten = this.buffer[this.end] as T;
    } else {
      this.count++;
    }
    this.start = (this.start - 1 + this.capacity) % this.capacity;
    this.buffer[this.start] = item;
    return overwritten;
  }

  shift(): T | undefined {
    if (this.isEmpty) return undefined;
    const item = this.buffer[this.start] as T;
    this.buffer[this.start] = undefined;
    this.start = (this.start + 1) % this.capacity;
    this.count--;
    return item;
  }

  at(index: number): T | undefined {
    const i = index < 0 ? this.count + index : index;
    if (i < 0 || i >= this.count) return undefined;
    return this.buffer[(this.start + i) % this.capacity] as T;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.count = 0;
    this.start = 0;
    this.end = 0;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.buffer[(this.start + i) % this.capacity] as T);
    }
    return result;
  }

  [Symbol.iterator](): Iterator<T> {
    let i = 0;
    return {
      next: () => {
        if (i < this.count) {
          return {
            value: this.buffer[(this.start + i++) % this.capacity] as T,
            done: false,
          };
        }
        return { value: undefined as unknown as T, done: true };
      },
    };
  }
}
