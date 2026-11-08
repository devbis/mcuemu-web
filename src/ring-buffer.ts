export class RingBuffer<T> {
  private readonly items: Array<T | undefined>;
  private start = 0;
  private length = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Ring buffer capacity must be positive.');
    this.items = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    if (this.length < this.capacity) {
      this.items[(this.start + this.length) % this.capacity] = item;
      this.length += 1;
    } else {
      this.items[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  clear(): void {
    this.items.fill(undefined);
    this.start = 0;
    this.length = 0;
  }

  values(): T[] {
    const result: T[] = [];
    for (let index = 0; index < this.length; index += 1) {
      const item = this.items[(this.start + index) % this.capacity];
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  get size(): number {
    return this.length;
  }
}
