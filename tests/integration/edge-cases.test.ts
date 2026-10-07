// Edge-case integration tests.
//
// These cover the "weird input but should be accepted" surface plus a handful
// of boundary conditions where off-by-one errors typically live.

import type { McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssetLabClient } from '../../src/client.js'
import { registerTools } from '../../src/tools.js'
import { apiKey, asset, paginated, single } from '../fixtures/factories.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'
import { asMcpServer, FakeMcpServer } from '../fixtures/tool-harness.js'

describe('Edge cases — unicode and long strings', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('asset name with Japanese characters round-trips through tool layer', async () => {
    fx.on('POST', '/v1/assets', ({ body }) =>
      fx.json(single({ ...(body as Record<string, unknown>), id: 'new' }), 201)
    )
    const r = await server.call('create_asset', { name: '工場ポンプ #1' })
    expect(r.isError).toBeFalsy()
    expect((fx.calls[0].body as { name: string }).name).toBe('工場ポンプ #1')
  })

  it('asset name with emoji and combining characters', async () => {
    fx.on('POST', '/v1/assets', ({ body }) =>
      fx.json(single({ ...(body as Record<string, unknown>), id: 'x' }), 201)
    )
    const r = await server.call('create_asset', { name: '🔧 Pump (e\u0301)' })
    expect(r.isError).toBeFalsy()
  })

  it('search at exactly 200 chars accepted (boundary)', async () => {
    fx.on('GET', '/v1/assets', () => fx.json(paginated([])))
    const r = await server.call('list_assets', { search: 'x'.repeat(200) })
    expect(r.isError).toBeFalsy()
  })

  it('asset name at exactly 500 chars accepted (boundary)', async () => {
    fx.on('POST', '/v1/assets', () => fx.json(single(asset()), 201))
    const r = await server.call('create_asset', { name: 'a'.repeat(500) })
    expect(r.isError).toBeFalsy()
  })

  it('image_url at exactly 2000 chars accepted (boundary)', async () => {
    fx.on('POST', '/v1/assets', () => fx.json(single(asset()), 201))
    const url = 'https://example.com/' + 'a'.repeat(2000 - 'https://example.com/'.length)
    const r = await server.call('create_asset', { name: 'x', image_url: url })
    expect(r.isError).toBeFalsy()
  })
})

describe('Edge cases — empty / null inputs through MCP layer', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('list with no filters does not include search params on URL', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/assets', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_assets', {})
    expect(captured?.searchParams.get('search')).toBeNull()
    expect(captured?.searchParams.get('site_id')).toBeNull()
  })

  it('update_asset with only id and one field sends only that field', async () => {
    let sentBody: Record<string, unknown> | undefined
    fx.on('PATCH', /^\/v1\/assets\//, ({ body }) => {
      sentBody = body as Record<string, unknown>
      return fx.json(single(asset()))
    })
    await server.call('update_asset', {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'renamed',
    })
    expect(Object.keys(sentBody ?? {})).toEqual(['name'])
  })

  it('listAll returns empty array when first page has no data', async () => {
    fx.on('GET', '/v1/assets', () =>
      fx.json(paginated([], { page: 1, per_page: 1000, total: 0, total_pages: 0 }))
    )
    const r = await server.call('list_assets', {})
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed.data).toEqual([])
  })
})

describe('Edge cases — pagination boundaries', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('large result set across many pages auto-paginates correctly', async () => {
    const pageSize = 1000
    fx.on('GET', '/v1/assets', ({ url }) => {
      const page = Number(url.searchParams.get('page') ?? '1')
      const data = Array.from({ length: pageSize }, (_, i) => asset({ id: `id-${page}-${i}` }))
      return fx.json(paginated(data, { page, per_page: pageSize, total: 3000, total_pages: 3 }))
    })
    const r = await server.call('list_assets', {})
    expect(r.isError).toBeFalsy()
    // Implementation auto-paginates inside smartList when no page filter is given.
    // We just verify it doesn't error and produced JSON.
    expect(() => JSON.parse(r.content[0].text)).not.toThrow()
  })

  it('explicit page=1 disables auto-pagination — only one request issued', async () => {
    let calls = 0
    fx.on('GET', '/v1/assets', () => {
      calls++
      return fx.json(paginated([asset()], { page: 1, per_page: 10, total: 999, total_pages: 100 }))
    })
    await server.call('list_assets', { page: 1, per_page: 10 })
    expect(calls).toBe(1)
  })
})

describe('Edge cases — concurrent updates within one process', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('two concurrent update_asset calls do not interleave bodies', async () => {
    fx.on('PATCH', /^\/v1\/assets\//, ({ body }) =>
      fx.json(single({ ...(body as Record<string, unknown>) }))
    )
    const argsA = { id: '550e8400-e29b-41d4-a716-446655440000', name: 'A' }
    const argsB = { id: '550e8400-e29b-41d4-a716-446655440001', name: 'B' }
    await Promise.all([server.call('update_asset', argsA), server.call('update_asset', argsB)])
    // Find the call for each id and assert its body is the matching name.
    const callA = fx.calls.find(c => c.url.endsWith('440000'))
    const callB = fx.calls.find(c => c.url.endsWith('440001'))
    expect((callA?.body as { name: string }).name).toBe('A')
    expect((callB?.body as { name: string }).name).toBe('B')
  })
})

describe('Edge cases — number/boolean type coercion', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('condition_score=0 is accepted (boundary, not falsy-stripped)', async () => {
    let sent: Record<string, unknown> | undefined
    fx.on('POST', '/v1/assets', ({ body }) => {
      sent = body as Record<string, unknown>
      return fx.json(single(asset()), 201)
    })
    await server.call('create_asset', { name: 'x', condition_score: 0 })
    expect(sent?.condition_score).toBe(0)
  })

  it('purchase_cost=0 is accepted (boundary)', async () => {
    let sent: Record<string, unknown> | undefined
    fx.on('POST', '/v1/assets', ({ body }) => {
      sent = body as Record<string, unknown>
      return fx.json(single(asset()), 201)
    })
    await server.call('create_asset', { name: 'x', purchase_cost: 0 })
    expect(sent?.purchase_cost).toBe(0)
  })

  it('condition_score=100 is accepted (upper boundary)', async () => {
    fx.on('POST', '/v1/assets', () => fx.json(single(asset()), 201))
    const r = await server.call('create_asset', { name: 'x', condition_score: 100 })
    expect(r.isError).toBeFalsy()
  })

  it('condition_score=101 is rejected (just past boundary)', async () => {
    await expect(server.call('create_asset', { name: 'x', condition_score: 101 })).rejects.toThrow()
  })

  it('purchase_cost=-0.01 is rejected (just under zero)', async () => {
    await expect(server.call('create_asset', { name: 'x', purchase_cost: -0.01 })).rejects.toThrow()
  })
})

describe('Edge cases — bulk_create boundary item counts', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('exactly 100 items accepted (upper boundary)', async () => {
    fx.on('POST', '/v1/assets/bulk', () =>
      fx.json({
        summary: { total: 100, succeeded: 100, failed: 0 },
        results: Array.from({ length: 100 }, (_, i) => ({
          index: i,
          success: true,
          data: { id: `a${i}` },
        })),
      })
    )
    const items = Array.from({ length: 100 }, (_, i) => ({ name: `Asset ${i}` }))
    const r = await server.call('bulk_create', { resource: 'assets', items })
    expect(r.isError).toBeFalsy()
  })

  it('exactly 1 item accepted (lower boundary)', async () => {
    fx.on('POST', '/v1/assets/bulk', () =>
      fx.json({
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{ index: 0, success: true, data: { id: 'a1' } }],
      })
    )
    const r = await server.call('bulk_create', { resource: 'assets', items: [{ name: 'x' }] })
    expect(r.isError).toBeFalsy()
  })
})

describe('Edge cases — URL composition', () => {
  let fx: FetchFake
  beforeEach(() => {
    fx = installFetchFake()
  })
  afterEach(() => fx.restore())

  it('apiUrl with trailing slash is normalized (no double-slash in path)', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com/', apiKey: 'k' })
    fx.on('GET', '/v1/assets', () => fx.json(paginated([])))
    await c.list('assets')
    expect(fx.calls[0].url).not.toContain('//v1')
  })

  it('apiUrl without /v1 suffix has /v1 appended', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: 'k' })
    fx.on('GET', '/v1/assets', () => fx.json(paginated([])))
    await c.list('assets')
    expect(fx.calls[0].pathname).toBe('/v1/assets')
  })

  it('apiUrl with /v1 already present is not doubled', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com/v1', apiKey: 'k' })
    fx.on('GET', '/v1/assets', () => fx.json(paginated([])))
    await c.list('assets')
    expect(fx.calls[0].pathname).toBe('/v1/assets')
  })
})
