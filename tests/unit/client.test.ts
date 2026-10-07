// Unit tests for AssetLabClient — the HTTP wrapper around the API gateway.
//
// What we verify here:
//  - URL composition (trailing slash normalization, /v1 prefix)
//  - Bearer header attached on every method
//  - Status-code -> error message mapping (401, 403, 404, 429, 400, other)
//  - listAll() auto-paginates correctly and stops on the last page
//  - bulk endpoints: 200/201/207/400-structured all return BulkResponse
//  - loadConfig() rejects missing env vars

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssetLabClient, AssetLabClientError, loadConfig } from '../../src/client.js'
import { apiKey } from '../fixtures/factories.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'

describe('AssetLabClient > URL composition', () => {
  let fx: FetchFake
  beforeEach(() => {
    fx = installFetchFake()
  })
  afterEach(() => fx.restore())

  it('appends /v1 when missing', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    fx.on('GET', '/v1/assets', () =>
      fx.json({ data: [], pagination: { page: 1, per_page: 1000, total: 0, total_pages: 0 } })
    )
    await c.list('assets')
    expect(fx.calls[0].pathname).toBe('/v1/assets')
  })

  it('strips trailing slashes', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com///', apiKey: apiKey() })
    fx.on('GET', '/v1/sites', () =>
      fx.json({ data: [], pagination: { page: 1, per_page: 1000, total: 0, total_pages: 0 } })
    )
    await c.list('sites')
    expect(fx.calls[0].url).toBe('https://api.example.com/v1/sites')
  })

  it('does not double-append /v1 when already present', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com/v1', apiKey: apiKey() })
    fx.on('GET', '/v1/sites', () =>
      fx.json({ data: [], pagination: { page: 1, per_page: 1000, total: 0, total_pages: 0 } })
    )
    await c.list('sites')
    expect(fx.calls[0].pathname).toBe('/v1/sites')
  })
})

describe('AssetLabClient > Authentication header', () => {
  let fx: FetchFake
  beforeEach(() => {
    fx = installFetchFake()
  })
  afterEach(() => fx.restore())

  it('attaches Bearer token to GET', async () => {
    const key = apiKey()
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: key })
    fx.on('GET', '/v1/assets', () =>
      fx.json({ data: [], pagination: { page: 1, per_page: 1000, total: 0, total_pages: 0 } })
    )
    await c.list('assets')
    expect(fx.calls[0].headers.authorization).toBe(`Bearer ${key}`)
  })

  it('attaches Bearer to POST/PATCH/DELETE', async () => {
    const key = apiKey()
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: key })
    fx.on('POST', '/v1/assets', () => fx.json({ data: { id: 'x' } }, 201))
    fx.on('PATCH', '/v1/assets/x', () => fx.json({ data: { id: 'x' } }))
    fx.on('DELETE', '/v1/assets/x', () => fx.json({ success: true, message: 'gone' }))
    await c.create('assets', { name: 'a' })
    await c.update('assets', 'x', { name: 'b' })
    await c.remove('assets', 'x')
    for (const call of fx.calls) {
      expect(call.headers.authorization).toBe(`Bearer ${key}`)
    }
  })

  it('pins every request to ca-central-1 via x-region (F-249)', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    fx.on('GET', '/v1/assets', () =>
      fx.json({ data: [], pagination: { page: 1, per_page: 1000, total: 0, total_pages: 0 } })
    )
    fx.on('POST', '/v1/assets', () => fx.json({ data: { id: 'x' } }, 201))
    fx.on('PATCH', '/v1/assets/x', () => fx.json({ data: { id: 'x' } }))
    fx.on('DELETE', '/v1/assets/x', () => fx.json({ success: true, message: 'gone' }))
    await c.list('assets')
    await c.create('assets', { name: 'a' })
    await c.update('assets', 'x', { name: 'b' })
    await c.remove('assets', 'x')
    expect(fx.calls).toHaveLength(4)
    for (const call of fx.calls) {
      expect(call.headers['x-region']).toBe('ca-central-1')
    }
  })

  it('sends Content-Type: application/json on POST', async () => {
    const c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    fx.on('POST', '/v1/sites', () => fx.json({ data: { id: '1' } }, 201))
    await c.create('sites', { name: 'HQ' })
    expect(fx.calls[0].headers['content-type']).toBe('application/json')
  })
})

describe('AssetLabClient > Error mapping', () => {
  let fx: FetchFake
  let c: AssetLabClient
  beforeEach(() => {
    fx = installFetchFake()
    c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
  })
  afterEach(() => fx.restore())

  it('401 -> "Authentication failed" with original key advice', async () => {
    fx.on('GET', '/v1/assets', () => fx.error(401, 'bad token'))
    await expect(c.list('assets')).rejects.toThrow(/ASSETLAB_API_KEY/)
  })

  it('403 with scope message preserves backend text', async () => {
    fx.on('GET', '/v1/assets', () => fx.error(403, 'Missing scope: assets:read'))
    await expect(c.list('assets')).rejects.toThrow(/Missing scope/)
  })

  it('403 with "expired" surfaces key-rotation hint', async () => {
    fx.on('GET', '/v1/assets', () => fx.error(403, 'API key expired'))
    await expect(c.list('assets')).rejects.toThrow(/API key has expired/)
  })

  it('429 returns rate-limit message', async () => {
    fx.on('GET', '/v1/assets', () => fx.error(429, 'too many'))
    await expect(c.list('assets')).rejects.toThrow(/Rate limit/)
  })

  it('404 preserves backend message', async () => {
    fx.on('GET', '/v1/assets/x', () => fx.error(404, 'Asset not found'))
    await expect(c.getOne('assets', 'x')).rejects.toThrow(/Asset not found/)
  })

  it('errors include status code on the AssetLabClientError instance', async () => {
    fx.on('GET', '/v1/assets', () => fx.error(429, 'x'))
    try {
      await c.list('assets')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AssetLabClientError)
      expect((err as AssetLabClientError).status).toBe(429)
    }
  })

  it('500 falls through as generic AssetLabClientError', async () => {
    fx.on('GET', '/v1/assets', () => fx.error(500, 'boom'))
    await expect(c.list('assets')).rejects.toThrow(/boom/)
  })

  it('non-JSON error body still produces typed error', async () => {
    fx.on('GET', '/v1/assets', () => ({
      status: 502,
      body: '<html>bad gateway</html>',
      headers: { 'content-type': 'text/html' },
    }))
    await expect(c.list('assets')).rejects.toThrow(/HTTP 502/)
  })

  it('PATCH 400 maps to bad-request error', async () => {
    fx.on('PATCH', '/v1/assets/x', () => fx.error(400, 'invalid risk_factor'))
    await expect(c.update('assets', 'x', { risk_factor: 'NOT_REAL' })).rejects.toThrow(
      /invalid risk_factor/
    )
  })

  it('DELETE 403 preserves scope error', async () => {
    fx.on('DELETE', '/v1/assets/x', () => fx.error(403, 'Missing scope: assets:write'))
    await expect(c.remove('assets', 'x')).rejects.toThrow(/Missing scope/)
  })
})

describe('AssetLabClient > listAll pagination', () => {
  let fx: FetchFake
  let c: AssetLabClient
  beforeEach(() => {
    fx = installFetchFake()
    c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
  })
  afterEach(() => fx.restore())

  it('walks every page and concatenates results', async () => {
    fx.on('GET', '/v1/assets', ({ url }) => {
      const page = Number(url.searchParams.get('page') ?? '1')
      if (page === 1)
        return fx.json({
          data: [{ id: 'a1' }, { id: 'a2' }],
          pagination: { page: 1, per_page: 1000, total: 3, total_pages: 2 },
        })
      if (page === 2)
        return fx.json({
          data: [{ id: 'a3' }],
          pagination: { page: 2, per_page: 1000, total: 3, total_pages: 2 },
        })
      return fx.error(500, 'should not be called')
    })
    const result = await c.listAll('assets')
    expect(result.total).toBe(3)
    expect(result.data.map(r => (r as { id: string }).id)).toEqual(['a1', 'a2', 'a3'])
    expect(fx.calls).toHaveLength(2)
  })

  it('stops at total_pages — never makes one extra call', async () => {
    let calls = 0
    fx.on('GET', '/v1/sites', () => {
      calls += 1
      return fx.json({
        data: [],
        pagination: { page: 1, per_page: 1000, total: 0, total_pages: 0 },
      })
    })
    await c.listAll('sites')
    expect(calls).toBe(1)
  })

  it('forwards filter params on every page', async () => {
    fx.on('GET', '/v1/assets', ({ url }) => {
      expect(url.searchParams.get('site_id')).toBe('site-123')
      return fx.json({
        data: [],
        pagination: { page: 1, per_page: 1000, total: 0, total_pages: 1 },
      })
    })
    await c.listAll('assets', { site_id: 'site-123' })
  })

  it('uses per_page=1000 by default for listAll', async () => {
    fx.on('GET', '/v1/assets', ({ url }) => {
      expect(url.searchParams.get('per_page')).toBe('1000')
      return fx.json({
        data: [],
        pagination: { page: 1, per_page: 1000, total: 0, total_pages: 1 },
      })
    })
    await c.listAll('assets')
  })
})

describe('AssetLabClient > bulk endpoints', () => {
  let fx: FetchFake
  let c: AssetLabClient
  beforeEach(() => {
    fx = installFetchFake()
    c = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
  })
  afterEach(() => fx.restore())

  it('bulkCreate: 201 fully-succeeded response passed through', async () => {
    fx.on('POST', '/v1/assets/bulk', () =>
      fx.json({ summary: { total: 2, succeeded: 2, failed: 0 }, results: [] }, 201)
    )
    const r = await c.bulkCreate('assets', [{ name: 'x' }, { name: 'y' }])
    expect(r.summary.succeeded).toBe(2)
  })

  it('bulkCreate: 207 partial success returns BulkResponse, does not throw', async () => {
    fx.on('POST', '/v1/assets/bulk', () =>
      fx.json(
        {
          summary: { total: 2, succeeded: 1, failed: 1 },
          results: [
            { index: 0, success: true, data: { id: 'a1' } },
            { index: 1, success: false, error: 'invalid' },
          ],
        },
        207
      )
    )
    const r = await c.bulkCreate('assets', [{ name: 'x' }, { name: 'y' }])
    expect(r.summary.failed).toBe(1)
    expect(r.results[1].success).toBe(false)
  })

  it('bulkCreate: 400 with summary returns structured failure (all failed)', async () => {
    fx.on('POST', '/v1/assets/bulk', () => ({
      status: 400,
      body: {
        summary: { total: 1, succeeded: 0, failed: 1 },
        results: [{ index: 0, success: false, error: 'invalid name' }],
      },
      headers: { 'content-type': 'application/json' },
    }))
    const r = await c.bulkCreate('assets', [{ name: '' }])
    expect(r.summary.failed).toBe(1)
  })

  it('bulkCreate: 400 without summary throws as bad request', async () => {
    fx.on('POST', '/v1/assets/bulk', () => fx.error(400, 'Malformed body'))
    await expect(c.bulkCreate('assets', [{ name: 'x' }])).rejects.toThrow(/Malformed body/)
  })

  it('bulkUpdate hits PATCH /resource/bulk', async () => {
    fx.on('PATCH', '/v1/assets/bulk', () =>
      fx.json(
        { summary: { total: 1, succeeded: 1, failed: 0 }, results: [{ index: 0, success: true }] },
        200
      )
    )
    await c.bulkUpdate('assets', [{ id: 'a1', name: 'updated' }])
    expect(fx.calls[0].method).toBe('PATCH')
  })

  it('bulk 401 yields auth error (one item or many)', async () => {
    fx.on('POST', '/v1/assets/bulk', () => fx.error(401, 'unauthorized'))
    await expect(c.bulkCreate('assets', [{ name: 'x' }])).rejects.toThrow(/ASSETLAB_API_KEY/)
  })

  it('bulk 429 yields rate-limit error', async () => {
    fx.on('POST', '/v1/assets/bulk', () => fx.error(429, 'rate'))
    await expect(c.bulkCreate('assets', [{ name: 'x' }])).rejects.toThrow(/Rate limit/)
  })
})

describe('loadConfig', () => {
  const orig = { key: process.env.ASSETLAB_API_KEY, url: process.env.ASSETLAB_API_URL }
  beforeEach(() => {
    delete process.env.ASSETLAB_API_KEY
    delete process.env.ASSETLAB_API_URL
  })
  afterEach(() => {
    if (orig.key !== undefined) process.env.ASSETLAB_API_KEY = orig.key
    else delete process.env.ASSETLAB_API_KEY
    if (orig.url !== undefined) process.env.ASSETLAB_API_URL = orig.url
    else delete process.env.ASSETLAB_API_URL
  })

  it('throws when ASSETLAB_API_KEY is missing', () => {
    process.env.ASSETLAB_API_URL = 'https://x.example.com'
    expect(() => loadConfig()).toThrow(/ASSETLAB_API_KEY/)
  })

  it('throws when ASSETLAB_API_URL is missing', () => {
    process.env.ASSETLAB_API_KEY = 'al_live_xxx'
    expect(() => loadConfig()).toThrow(/ASSETLAB_API_URL/)
  })

  it('returns config when both vars present', () => {
    process.env.ASSETLAB_API_KEY = 'al_live_xxx'
    process.env.ASSETLAB_API_URL = 'https://x.example.com'
    expect(loadConfig()).toEqual({ apiKey: 'al_live_xxx', apiUrl: 'https://x.example.com' })
  })
})
