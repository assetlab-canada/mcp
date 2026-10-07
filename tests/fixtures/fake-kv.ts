// In-memory Cloudflare KVNamespace fake.
// Implements the subset of the KV surface that oauth.ts/worker.ts use:
//   get(key) -> string|null
//   put(key, value, opts?) -> void  (expirationTtl honored via setTimeout in fake)
//   delete(key) -> void
//
// Each test should construct a fresh FakeKV — never share across tests.

import type { KVNamespace } from '../../src/worker.js'

export class FakeKV implements KVNamespace {
  private store = new Map<string, string>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }

  async put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number; expiration?: number }
  ): Promise<void> {
    this.store.set(key, value)
    const existing = this.timers.get(key)
    if (existing) clearTimeout(existing)
    if (opts?.expirationTtl && opts.expirationTtl > 0) {
      const t = setTimeout(() => {
        this.store.delete(key)
        this.timers.delete(key)
      }, opts.expirationTtl * 1000)
      // Don't keep the test process alive just for TTLs.
      // @ts-expect-error unref exists in Node Timeout
      t.unref?.()
      this.timers.set(key, t)
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
    const existing = this.timers.get(key)
    if (existing) {
      clearTimeout(existing)
      this.timers.delete(key)
    }
  }

  // Test-only helpers — never used by production code.
  _size(): number {
    return this.store.size
  }
  _keys(): string[] {
    return [...this.store.keys()]
  }
  _raw(key: string): string | undefined {
    return this.store.get(key)
  }
  _clear(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.store.clear()
  }
}
