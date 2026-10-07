// Rate limiting in front of the Worker: an unauthenticated flood must not turn into unbounded
// KV writes (POST /oauth/register) or api-gateway invocations (MCP transport).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import worker from '../../src/worker.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'
import { FakeKV } from '../fixtures/fake-kv.js'
import { FakeRateLimiter, openLimiters } from '../fixtures/fake-rate-limiter.js'

class CountingKV extends FakeKV {
  puts = 0
  override async put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number; expiration?: number }
  ): Promise<void> {
    this.puts++
    return super.put(key, value, opts)
  }
}

type WorkerEnv = Parameters<typeof worker.fetch>[1]

function makeEnv(kv: FakeKV, limiters: Partial<ReturnType<typeof openLimiters>> = {}): WorkerEnv {
  return {
    ASSETLAB_API_URL: 'https://api.example.com',
    OAUTH_SECRET: 'x'.repeat(48),
    OAUTH_CLIENTS: kv,
    ...openLimiters(),
    ...limiters,
  } as unknown as WorkerEnv
}

function registerRequest(ip: string, origin?: string): Request {
  return new Request('https://mcp.assetlab.ca/oauth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
  })
}

describe('POST /oauth/register rate limiting', () => {
  it('returns 429 with Retry-After once one IP exceeds its limit, and writes nothing', async () => {
    const kv = new CountingKV()
    const env = makeEnv(kv, { REGISTER_IP_LIMITER: new FakeRateLimiter(2) })

    expect((await worker.fetch(registerRequest('203.0.113.7'), env)).status).toBe(201)
    expect((await worker.fetch(registerRequest('203.0.113.7'), env)).status).toBe(201)
    const res = await worker.fetch(registerRequest('203.0.113.7'), env)

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
    expect(((await res.json()) as { error: string }).error).toBe('rate_limited')
    expect(kv.puts).toBe(2)
  })

  it('keeps other IPs registering while one IP is limited', async () => {
    const env = makeEnv(new FakeKV(), { REGISTER_IP_LIMITER: new FakeRateLimiter(1) })

    await worker.fetch(registerRequest('203.0.113.7'), env)
    expect((await worker.fetch(registerRequest('203.0.113.7'), env)).status).toBe(429)
    expect((await worker.fetch(registerRequest('198.51.100.9'), env)).status).toBe(201)
  })

  it('caps registrations globally so a distributed flood is bounded too', async () => {
    const kv = new CountingKV()
    const env = makeEnv(kv, { REGISTER_GLOBAL_LIMITER: new FakeRateLimiter(2) })

    await worker.fetch(registerRequest('203.0.113.1'), env)
    await worker.fetch(registerRequest('203.0.113.2'), env)
    const res = await worker.fetch(registerRequest('203.0.113.3'), env)

    expect(res.status).toBe(429)
    expect(kv.puts).toBe(2)
  })

  it('does not spend the global budget on calls the per-IP limit already rejected', async () => {
    const global = new FakeRateLimiter()
    const env = makeEnv(new FakeKV(), {
      REGISTER_IP_LIMITER: new FakeRateLimiter(1),
      REGISTER_GLOBAL_LIMITER: global,
    })

    for (let i = 0; i < 5; i++) await worker.fetch(registerRequest('203.0.113.7'), env)

    expect(global.keys).toHaveLength(1)
  })

  it('sends no CORS headers on the 429 (F-006: /oauth/register is server-to-server)', async () => {
    const env = makeEnv(new FakeKV(), { REGISTER_IP_LIMITER: new FakeRateLimiter(0) })
    const res = await worker.fetch(registerRequest('203.0.113.7', 'https://claude.ai'), env)

    expect(res.status).toBe(429)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('Worker-wide request rate limiting', () => {
  let fx: FetchFake
  beforeEach(() => {
    fx = installFetchFake()
  })
  afterEach(() => fx.restore())

  it('rejects an over-limit MCP call before it reaches the api-gateway', async () => {
    const env = makeEnv(new FakeKV(), { REQUEST_LIMITER: new FakeRateLimiter(0) })
    const res = await worker.fetch(
      new Request('https://mcp.assetlab.ca/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer al_live_flood',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.7',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      env
    )

    expect(res.status).toBe(429)
    expect(fx.calls).toHaveLength(0)
  })

  it('keys the limit on the connecting IP', async () => {
    const limiter = new FakeRateLimiter()
    const env = makeEnv(new FakeKV(), { REQUEST_LIMITER: limiter })
    await worker.fetch(
      new Request('https://mcp.assetlab.ca/', { headers: { 'CF-Connecting-IP': '198.51.100.9' } }),
      env
    )

    expect(limiter.keys).toEqual(['198.51.100.9'])
  })

  it('does not count CORS preflights', async () => {
    const limiter = new FakeRateLimiter(0)
    const env = makeEnv(new FakeKV(), { REQUEST_LIMITER: limiter })
    const res = await worker.fetch(
      new Request('https://mcp.assetlab.ca/mcp', { method: 'OPTIONS' }),
      env
    )

    expect(res.status).toBe(204)
    expect(limiter.keys).toHaveLength(0)
  })
})
