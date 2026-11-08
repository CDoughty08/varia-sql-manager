/** A label keeps its sprite while it remains visible, regardless of spatial-query order.
 * Retired sprites can be reused, but a zoomed-out frame cannot leave an unbounded texture pool. */
export class LabelPool<T> {
  private readonly active = new Map<string, T>()
  private readonly free: T[] = []
  private readonly used = new Set<string>()
  constructor(private readonly create: () => T, private readonly hide: (sprite: T) => void, private readonly destroy: (sprite: T) => void, private readonly spareLimit = 128) {}
  begin(): void { this.used.clear() }
  get(key: string): T {
    this.used.add(key)
    let sprite = this.active.get(key)
    if (!sprite) { sprite = this.free.pop() ?? this.create(); this.active.set(key, sprite) }
    return sprite
  }
  end(): number {
    let destroyed = 0
    for (const [key, sprite] of this.active) if (!this.used.has(key)) {
      this.active.delete(key)
      this.hide(sprite)
      if (this.free.length < this.spareLimit) this.free.push(sprite)
      else { this.destroy(sprite); destroyed++ }
    }
    return destroyed
  }
  get stats() { return { active: this.active.size, spare: this.free.length } }
  dispose(): void {
    for (const sprite of this.active.values()) this.destroy(sprite)
    for (const sprite of this.free) this.destroy(sprite)
    this.active.clear(); this.free.length = 0; this.used.clear()
  }
}
