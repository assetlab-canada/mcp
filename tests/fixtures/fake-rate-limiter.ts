// In-memory fake of the Workers Rate Limiting binding: allows `limit` calls per key, then denies.

import type { RateLimiter } from '../../src/worker.js'

export class FakeRateLimiter implements RateLimiter {
  readonly keys: string[] = []
  private counts = new Map<string, number>()

  constructor(private readonly max = Number.POSITIVE_INFINITY) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(key)
    const next = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, next)
    return { success: next <= this.max }
  }
}

export function openLimiters() {
  return {
    REQUEST_LIMITER: new FakeRateLimiter(),
    REGISTER_IP_LIMITER: new FakeRateLimiter(),
    REGISTER_GLOBAL_LIMITER: new FakeRateLimiter(),
  }
}
