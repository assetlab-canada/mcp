// The Worker builds its tool catalogue once per isolate and shares one AssetLabClient across
// requests, reading each request's API key from AsyncLocalStorage (3.0.1). Requests interleave in
// an isolate, so the failure this guards is a gateway call made with another tenant's key - a
// cross-tenant read or write that every single-request test would pass.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import worker from '../../src/worker.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'
import { FakeKV } from '../fixtures/fake-kv.js'
import { openLimiters } from '../fixtures/fake-rate-limiter.js'

type WorkerEnv = Parameters<typeof worker.fetch>[1]

const KEYS = [
  'al_test_tenant_a_000000000000000000',
  'al_test_tenant_b_000000000000000000',
  'al_test_tenant_c_000000000000000000',
]

function env(): WorkerEnv {
  return {
    ASSETLAB_API_URL: 'https://api.example.com',
    OAUTH_SECRET: 'x'.repeat(48),
    OAUTH_CLIENTS: new FakeKV(),
    ...openLimiters(),
  } as unknown as WorkerEnv
}

function callTool(key: string, name: string, args: Record<string, unknown>, id: number): Request {
  return new Request('https://mcp.assetlab.ca/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('concurrent requests from different tenants', () => {
  let fx: FetchFake
  // Each gateway call records the key it carried and the requester tag it was made for.
  let seen: Array<{ carried: string | null; for: string | null }>

  beforeEach(() => {
    fx = installFetchFake()
    seen = []
    fx.on('GET', '/v1/assets', async ({ url, headers }) => {
      await sleep(Math.random() * 15)
      seen.push({ carried: headers.get('authorization'), for: url.searchParams.get('search') })
      return fx.json({
        data: [],
        pagination: { page: 1, per_page: 1000, total: 0, total_pages: 1 },
      })
    })
    fx.on('POST', '/v1/work-orders', async ({ body, headers }) => {
      await sleep(Math.random() * 15)
      seen.push({ carried: headers.get('authorization'), for: (body as { title: string }).title })
      return fx.json({ data: { id: 'wo', ...(body as object) } }, 201)
    })
  })
  afterEach(() => fx.restore())

  it('sends every gateway call with the key of the request that made it', async () => {
    const e = env()
    const requests = Array.from({ length: 90 }, (_, i) => {
      const key = KEYS[i % KEYS.length]
      return i % 2
        ? worker.fetch(callTool(key, 'list_assets', { search: key }, i), e)
        : worker.fetch(
            callTool(
              key,
              'create_work_order',
              { title: key, priority: 'LOW', type: 'REACTIVE' },
              i
            ),
            e
          )
    })
    const responses = await Promise.all(requests)
    await Promise.all(responses.map(r => r.text()))

    expect(seen).toHaveLength(90)
    const crossed = seen.filter(s => s.carried !== `Bearer ${s.for}`)
    expect(crossed).toEqual([])
    for (const key of KEYS) {
      expect(seen.filter(s => s.carried === `Bearer ${key}`)).toHaveLength(30)
    }
  })

  it('keeps the key bound across a paginated read that spans several gateway calls', async () => {
    fx.restore()
    fx = installFetchFake()
    seen = []
    fx.on('GET', '/v1/assets', async ({ url, headers }) => {
      await sleep(Math.random() * 10)
      const page = Number(url.searchParams.get('page') ?? 1)
      seen.push({ carried: headers.get('authorization'), for: url.searchParams.get('search') })
      return fx.json({
        data: [{ id: `p${page}` }],
        pagination: { page, per_page: 1000, total: 3, total_pages: 3 },
      })
    })
    const e = env()
    const responses = await Promise.all(
      KEYS.flatMap((key, k) =>
        [0, 1, 2].map(i =>
          worker.fetch(callTool(key, 'list_assets', { search: key }, k * 10 + i), e)
        )
      )
    )
    await Promise.all(responses.map(r => r.text()))

    expect(seen).toHaveLength(27)
    expect(seen.filter(s => s.carried !== `Bearer ${s.for}`)).toEqual([])
  })
})
