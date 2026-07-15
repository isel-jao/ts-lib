export class Registry<V> {
  private readonly entries = new Map<string, V>();

  register(name: string, value: V): void {
    if (this.entries.has(name)) throw new Error(`Already registered: ${name}`);
    this.entries.set(name, value);
  }

  upsert(name: string, value: V): void {
    this.entries.set(name, value);
  }

  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  get(name: string): V | undefined {
    return this.entries.get(name);
  }

  require(name: string): V {
    const val = this.entries.get(name);
    if (!val) throw new Error(`Not registered: ${name}`);
    return val;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  list(): string[] {
    return Array.from(this.entries.keys());
  }
}
