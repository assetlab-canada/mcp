// 3.0.1. The 3.0.0 Worker rebuilt all 481 tool schemas on every request: ~31 ms of CPU per
// tools/list in workerd against the Workers Free tier's 10 ms, and Error 1102 in production
// within half an hour (rolled back, PB-001 2026-10-07). The catalogue is now built once per
// isolate. This pins that: however many requests arrive, tool registration runs once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const counts = vi.hoisted(() => ({ registerTools: 0 }))

vi.mock('../../src/tools.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/tools.js')>()
  return {
    ...actual,
    registerTools: (...args: Parameters<typeof actual.registerTools>) => {
      counts.registerTools++
      return actual.registerTools(...args)
    },
  }
})

const { default: worker } = await import('../../src/worker.js')
const { installFetchFake } = await import('../fixtures/fake-fetch.js')
const { FakeKV } = await import('../fixtures/fake-kv.js')
const { openLimiters } = await import('../fixtures/fake-rate-limiter.js')

type WorkerEnv = Parameters<typeof worker.fetch>[1]

function rpc(method: string, params: Record<string, unknown>, id: number, query = ''): Request {
  return new Request(`https://mcp.assetlab.ca/mcp${query}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer al_test_catalogue_once_0000000000',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
}

describe('tool catalogue (3.0.1)', () => {
  let fx: ReturnType<typeof installFetchFake>
  beforeEach(() => {
    fx = installFetchFake()
    fx.on('GET', '/v1/assets', () =>
      fx.json({ data: [], pagination: { page: 1, per_page: 1000, total: 0, total_pages: 1 } })
    )
  })
  afterEach(() => fx.restore())

  it('registers the tools once per isolate, not once per request', async () => {
    const env = {
      ASSETLAB_API_URL: 'https://api.example.com',
      OAUTH_SECRET: 'x'.repeat(48),
      OAUTH_CLIENTS: new FakeKV(),
      ...openLimiters(),
    } as unknown as WorkerEnv
    const before = counts.registerTools
    for (let i = 0; i < 12; i++) {
      const res = await worker.fetch(
        i % 3 === 0
          ? rpc('tools/list', {}, i)
          : i % 3 === 1
            ? rpc('tools/call', { name: 'list_assets', arguments: {} }, i)
            : rpc('tools/list', {}, i, '?profile=core'),
        env
      )
      expect(res.status).toBe(200)
      await res.text()
    }
    expect(counts.registerTools).toBeLessThanOrEqual(1)
    expect(counts.registerTools - before).toBe(0)
  })
})
