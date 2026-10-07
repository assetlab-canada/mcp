// Multi-tenant isolation tests.
//
// Tenant boundary is enforced server-side by the AssetLab API gateway via
// RLS on tenant_id = clerk_org_id(). The MCP server itself is a passthrough.
// What we verify is that the client correctly carries the caller's API key
// (and only that key) on every request — no cross-tenant leakage path exists
// in the MCP layer.
//
// Real tenant-isolation enforcement is asserted via the API gateway's 403
// response for cross-tenant id access, which the client correctly surfaces.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssetLabClient } from '../../src/client.js'
import { apiKey, asset, paginated } from '../fixtures/factories.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'

describe('Multi-tenant isolation — client never mixes keys', () => {
  let fx: FetchFake
  beforeEach(() => {
    fx = installFetchFake()
  })
  afterEach(() => fx.restore())

  it('two clients in the same process send distinct Bearer tokens', async () => {
    const keyA = apiKey('live', 1)
    const keyB = apiKey('live', 2)
    const a = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: keyA })
    const b = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: keyB })
    fx.on('GET', '/v1/assets', () => fx.json(paginated([])))
    await a.list('assets')
    await b.list('assets')
    expect(fx.calls[0].headers.authorization).toBe(`Bearer ${keyA}`)
    expect(fx.calls[1].headers.authorization).toBe(`Bearer ${keyB}`)
    expect(keyA).not.toBe(keyB)
  })

  it('UUID-spoofing GET — fabricated id targeting another tenant returns 404, not data', async () => {
    // Tenant A's API key is what we present. The gateway's RLS returns 404 for
    // Tenant B's row id because the row is invisible to Tenant A.
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    fx.on('GET', '/v1/assets/11111111-1111-1111-1111-111111111111', () =>
      fx.error(404, 'Asset not found')
    )
    await expect(c.getOne('assets', '11111111-1111-1111-1111-111111111111')).rejects.toThrow(
      /Asset not found/
    )
  })

  it('UUID-spoofing UPDATE — fabricated id is rejected by API gateway', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    fx.on('PATCH', '/v1/assets/22222222-2222-2222-2222-222222222222', () =>
      fx.error(404, 'Asset not found')
    )
    await expect(
      c.update('assets', '22222222-2222-2222-2222-222222222222', { name: 'x' })
    ).rejects.toThrow(/not found/)
  })

  it('UUID-spoofing DELETE — fabricated id is rejected', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    fx.on('DELETE', '/v1/assets/33333333-3333-3333-3333-333333333333', () =>
      fx.error(404, 'Asset not found')
    )
    await expect(c.remove('assets', '33333333-3333-3333-3333-333333333333')).rejects.toThrow(
      /not found/
    )
  })

  // F-016 — defense-in-depth. Gateway is still authoritative (overrides from
  // the verified Clerk JWT), but the MCP client now also strips identity keys
  // so a future gateway misconfig can't immediately turn into a tenant bypass.
  it('strips caller-supplied tenant_id before forwarding to the gateway (F-016)', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    fx.on('POST', '/v1/assets', () =>
      fx.json({ data: asset({ tenant_id: 'org_real_caller' }) }, 201)
    )
    await c.create('assets', { name: 'x', tenant_id: 'org_other_tenant_attempt' })
    const sent = fx.calls[0].body as Record<string, unknown>
    expect(sent).not.toHaveProperty('tenant_id')
    expect(sent.name).toBe('x') // other fields preserved
  })

  it('strips organization_id and org_id aliases on create (F-016)', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    fx.on('POST', '/v1/assets', () => fx.json({ data: asset() }, 201))
    await c.create('assets', {
      name: 'x',
      organization_id: 'org_attempt_a',
      org_id: 'org_attempt_b',
    })
    const sent = fx.calls[0].body as Record<string, unknown>
    expect(sent).not.toHaveProperty('organization_id')
    expect(sent).not.toHaveProperty('org_id')
    expect(sent.name).toBe('x')
  })

  it('strips identity keys on update (F-016)', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    fx.on('PATCH', '/v1/assets/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', () =>
      fx.json({ data: asset() })
    )
    await c.update('assets', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', {
      name: 'updated',
      tenant_id: 'org_attempt',
    })
    const sent = fx.calls[0].body as Record<string, unknown>
    expect(sent).not.toHaveProperty('tenant_id')
    expect(sent.name).toBe('updated')
  })

  it('strips identity keys per-item on bulkCreate (F-016)', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    fx.on('POST', '/v1/assets/bulk', () =>
      fx.json({ summary: { total: 2, succeeded: 2, failed: 0 }, results: [] })
    )
    await c.bulkCreate('assets', [
      { name: 'one', tenant_id: 'org_attempt_1' },
      { name: 'two', organization_id: 'org_attempt_2' },
    ])
    const items = fx.calls[0].body as Array<Record<string, unknown>>
    expect(items[0]).not.toHaveProperty('tenant_id')
    expect(items[1]).not.toHaveProperty('organization_id')
    expect(items[0].name).toBe('one')
    expect(items[1].name).toBe('two')
  })

  it('does not mutate the caller-provided payload object (F-016)', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    fx.on('POST', '/v1/assets', () => fx.json({ data: asset() }, 201))
    const original = { name: 'x', tenant_id: 'org_attempt' }
    await c.create('assets', original)
    // Caller's object must not be mutated — they may reuse it or log it.
    expect(original).toHaveProperty('tenant_id', 'org_attempt')
  })

  it('listAll auto-pagination uses the same Bearer key on every page', async () => {
    const key = apiKey()
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: key })
    fx.on('GET', '/v1/assets', ({ url }) => {
      const page = Number(url.searchParams.get('page') ?? '1')
      return fx.json(paginated([asset()], { page, per_page: 1000, total: 3, total_pages: 3 }))
    })
    await c.listAll('assets')
    for (const call of fx.calls) {
      expect(call.headers.authorization).toBe(`Bearer ${key}`)
    }
  })

  it('two MCP requests in same async stack do not bleed Bearer tokens', async () => {
    const keyA = apiKey('live', 100)
    const keyB = apiKey('live', 200)
    const a = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: keyA })
    const b = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: keyB })
    fx.on('GET', '/v1/assets', () => fx.json(paginated([])))
    await Promise.all([a.list('assets'), b.list('assets'), a.list('assets')])
    const aCalls = fx.calls.filter(c => c.headers.authorization === `Bearer ${keyA}`)
    const bCalls = fx.calls.filter(c => c.headers.authorization === `Bearer ${keyB}`)
    expect(aCalls.length).toBe(2)
    expect(bCalls.length).toBe(1)
  })
})
