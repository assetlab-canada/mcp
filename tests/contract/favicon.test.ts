// Claude's connector directory shows the favicon at the server URL. The Worker
// answers every unauthenticated GET with 401 to start OAuth, so without a
// dedicated route the listing has no icon.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import worker from '../../src/worker.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'
import { FakeKV } from '../fixtures/fake-kv.js'
import { openLimiters } from '../fixtures/fake-rate-limiter.js'

const env = {
  ASSETLAB_API_URL: 'https://api.example.com',
  OAUTH_SECRET: 'x'.repeat(48),
  OAUTH_CLIENTS: new FakeKV(),
  ...openLimiters(),
} as unknown as Parameters<typeof worker.fetch>[1]

describe('favicon routes', () => {
  let fx: FetchFake
  beforeEach(() => {
    fx = installFetchFake()
    fx.on('GET', '/favicon.ico', () => ({
      body: 'ICO',
      headers: { 'content-type': 'image/vnd.microsoft.icon' },
    }))
  })
  afterEach(() => fx.restore())

  it('serves /favicon.ico without authentication', async () => {
    const res = await worker.fetch(new Request('https://mcp.assetlab.ca/favicon.ico'), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/vnd.microsoft.icon')
    expect(await res.text()).toBe('ICO')
    expect(fx.calls[0].url).toBe('https://app.assetlab.ca/favicon.ico')
  })

  it('returns 404 when the app origin has no such icon', async () => {
    const res = await worker.fetch(new Request('https://mcp.assetlab.ca/apple-touch-icon.png'), env)
    expect(res.status).toBe(404)
  })

  it('still answers other unauthenticated GETs with 401', async () => {
    const res = await worker.fetch(new Request('https://mcp.assetlab.ca/'), env)
    expect(res.status).toBe(401)
  })
})
