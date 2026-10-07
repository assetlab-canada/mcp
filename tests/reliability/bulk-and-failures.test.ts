// Reliability tests — partial failure, retries, idempotency, error mapping.
//
// We exercise the bulk endpoints (the riskiest paths) plus a handful of
// edge cases around network failures and timeouts.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssetLabClient } from '../../src/client.js'
import { registerTools } from '../../src/tools.js'
import { apiKey, paginated } from '../fixtures/factories.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'
import { asMcpServer, FakeMcpServer } from '../fixtures/tool-harness.js'

describe('bulk_create — partial-failure handling', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('207 multi-status surfaces per-item results', async () => {
    fx.on('POST', '/v1/assets/bulk', () =>
      fx.json(
        {
          summary: { total: 3, succeeded: 2, failed: 1 },
          results: [
            { index: 0, success: true, data: { id: 'a1' } },
            {
              index: 1,
              success: false,
              error: 'invalid risk_factor',
              details: [{ field: 'risk_factor', message: 'invalid' }],
            },
            { index: 2, success: true, data: { id: 'a3' } },
          ],
        },
        207
      )
    )
    const r = await server.call('bulk_create', {
      resource: 'assets',
      items: [{ name: 'a' }, { name: 'b', risk_factor: 'INVALID' }, { name: 'c' }],
    })
    expect(r.isError).toBeFalsy()
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed.summary.failed).toBe(1)
    expect(parsed.results[1].error).toBe('invalid risk_factor')
  })

  it('400 with summary returns structured failure (not thrown)', async () => {
    fx.on('POST', '/v1/assets/bulk', () => ({
      status: 400,
      body: {
        summary: { total: 1, succeeded: 0, failed: 1 },
        results: [{ index: 0, success: false, error: 'missing name' }],
      },
      headers: { 'content-type': 'application/json' },
    }))
    const r = await server.call('bulk_create', { resource: 'assets', items: [{}] })
    expect(r.isError).toBeFalsy()
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed.summary.failed).toBe(1)
  })

  it('400 without summary surfaces as MCP error response', async () => {
    fx.on('POST', '/v1/assets/bulk', () => fx.error(400, 'Malformed body'))
    const r = await server.call('bulk_create', { resource: 'assets', items: [{ name: 'x' }] })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('Malformed body')
  })

  it('429 surfaces rate-limit error to caller', async () => {
    fx.on('POST', '/v1/assets/bulk', () => fx.error(429, 'rate'))
    const r = await server.call('bulk_create', { resource: 'assets', items: [{ name: 'x' }] })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('Rate limit')
  })

  it('401 from gateway surfaces clear auth message', async () => {
    fx.on('POST', '/v1/assets/bulk', () => fx.error(401, 'bad token'))
    const r = await server.call('bulk_create', { resource: 'assets', items: [{ name: 'x' }] })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('ASSETLAB_API_KEY')
  })
})

describe('Network failures', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('502 surfaces as user-readable error, not crash', async () => {
    fx.on('GET', '/v1/assets', () => ({
      status: 502,
      body: 'bad gateway',
      headers: { 'content-type': 'text/plain' },
    }))
    const r = await server.call('list_assets', {})
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('HTTP 502')
  })

  it('Connection-error fetch rejection surfaces as MCP error response', async () => {
    fx.on('GET', '/v1/assets', () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    })
    const r = await server.call('list_assets', {})
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('ECONNREFUSED')
  })

  it('JSON-parse error in response body falls back to generic error', async () => {
    fx.on('GET', '/v1/assets', () => ({
      status: 500,
      body: '{ not json',
      headers: { 'content-type': 'application/json' },
    }))
    const r = await server.call('list_assets', {})
    expect(r.isError).toBe(true)
  })
})

describe('Idempotency / deterministic behavior', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('list_assets called twice with same params produces identical requests', async () => {
    fx.on('GET', '/v1/assets', () => fx.json(paginated([])))
    await server.call('list_assets', {
      search: 'pump',
      site_id: '550e8400-e29b-41d4-a716-446655440000',
    })
    await server.call('list_assets', {
      search: 'pump',
      site_id: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(fx.calls[0].url).toBe(fx.calls[1].url)
  })

  it('update_asset retains buildBody behavior — sending the same update twice is safe', async () => {
    fx.on('PATCH', /^\/v1\/assets\//, () => fx.json({ data: { id: 'x' } }))
    const args = { id: '550e8400-e29b-41d4-a716-446655440000', condition_score: 70 }
    await server.call('update_asset', args)
    await server.call('update_asset', args)
    expect(fx.calls[0].body).toEqual(fx.calls[1].body)
  })
})
