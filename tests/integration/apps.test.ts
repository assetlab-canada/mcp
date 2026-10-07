// MCP Apps pilot - show_site_fci_trend and its ui:// view.
//
// Runs a real McpServer and Client over the SDK's in-memory transport, because
// what makes a host render the view is wire shape: _meta on tools/list, the MIME
// type and CSP on resources/read, structuredContent on tools/call. The fake
// server in tool-harness.ts sees none of those.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MCP_APP_MIME_TYPE, registerApps, SITE_FCI_TREND_URI } from '../../src/apps/index.js'
import {
  FCI_COLORS,
  FCI_FAIR_BOUND,
  FCI_GOOD_BOUND,
  SITE_FCI_TREND_HTML,
} from '../../src/apps/site-fci-trend-view.js'
import { AssetLabClient } from '../../src/client.js'
import { apiKey, paginated, single, uuid } from '../fixtures/factories.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'

const SITE_ID = uuid('site-fci')

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

function historyRow(date: string, fci: number) {
  return {
    id: uuid(),
    site_id: SITE_ID,
    fci_value: fci,
    recorded_date: date,
    sites: { id: SITE_ID, name: 'Main Library' },
  }
}

type TextContent = { type: 'text'; text: string }

describe('MCP Apps: show_site_fci_trend', () => {
  let fx: FetchFake
  let client: Client

  beforeEach(async () => {
    fx = installFetchFake()
    const server = new McpServer({ name: 'assetlab-test', version: '0.0.0' })
    const api = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerApps(server, api)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    client = new Client({ name: 'test-host', version: '0.0.0' })
    await client.connect(clientSide)
  })
  afterEach(async () => {
    await client.close()
    fx.restore()
  })

  function mockSite() {
    fx.on('GET', `/v1/sites/${SITE_ID}`, () =>
      fx.json(single({ id: SITE_ID, name: 'Main Library' }))
    )
  }

  describe('tools/list', () => {
    it('links the tool to its ui:// view under both the current and the legacy _meta key', async () => {
      const { tools } = await client.listTools()
      const tool = tools.find(t => t.name === 'show_site_fci_trend')
      expect(tool?._meta).toEqual({
        ui: { resourceUri: SITE_FCI_TREND_URI },
        'ui/resourceUri': SITE_FCI_TREND_URI,
      })
    })

    it('is annotated read-only with a title, as the connector directory requires', async () => {
      const { tools } = await client.listTools()
      const tool = tools.find(t => t.name === 'show_site_fci_trend')
      expect(tool?.annotations?.readOnlyHint).toBe(true)
      expect(tool?.annotations?.destructiveHint).toBe(false)
      expect(tool?.title).toBe('Show site FCI trend')
    })

    it('tells the model FCI is lower-is-better and not a condition score', async () => {
      const { tools } = await client.listTools()
      const description = tools.find(t => t.name === 'show_site_fci_trend')?.description ?? ''
      expect(description).toMatch(/LOWER is healthier/)
      expect(description).toMatch(/not a 0-100 condition score/)
    })
  })

  describe('resources/read', () => {
    it('serves the view as text/html;profile=mcp-app with an empty CSP', async () => {
      const { contents } = await client.readResource({ uri: SITE_FCI_TREND_URI })
      expect(contents).toHaveLength(1)
      const [view] = contents
      expect(view.mimeType).toBe(MCP_APP_MIME_TYPE)
      expect(view._meta).toEqual({ ui: { csp: {}, prefersBorder: true } })
      expect('text' in view && view.text.startsWith('<!doctype html>')).toBe(true)
    })

    it('is listed so hosts can prefetch it', async () => {
      const { resources } = await client.listResources()
      expect(resources.map(r => r.uri)).toContain(SITE_FCI_TREND_URI)
    })
  })

  describe('tools/call', () => {
    it('returns a text summary and an ascending, windowed series for the view', async () => {
      mockSite()
      fx.on('GET', '/v1/site-fci-history', ({ url }) => {
        expect(url.searchParams.get('site_id')).toBe(SITE_ID)
        return fx.json(
          paginated([
            historyRow(daysAgo(1), 0.072),
            historyRow(daysAgo(30), 0.041),
            historyRow(daysAgo(400), 0.02),
          ])
        )
      })

      const result = await client.callTool({
        name: 'show_site_fci_trend',
        arguments: { site_id: SITE_ID, days: 90 },
      })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual({
        site: { id: SITE_ID, name: 'Main Library' },
        days: 90,
        points: [
          { date: daysAgo(30), fci: 0.041 },
          { date: daysAgo(1), fci: 0.072 },
        ],
        latest: { date: daysAgo(1), fci: 0.072, band: 'fair' },
      })
      const text = (result.content as TextContent[])[0].text
      expect(text).toContain('FCI 7.2% (fair)')
      expect(text).toContain('2 readings in the last 90 days')
    })

    it('bands at the canonical bounds: 5% is fair and 10% is poor', async () => {
      mockSite()
      fx.on('GET', '/v1/site-fci-history', () =>
        fx.json(paginated([historyRow(daysAgo(2), 0.05), historyRow(daysAgo(1), 0.1)]))
      )
      const result = await client.callTool({
        name: 'show_site_fci_trend',
        arguments: { site_id: SITE_ID },
      })
      expect((result.structuredContent as { latest: { band: string } }).latest.band).toBe('poor')
    })

    it('says why a site with no readings has none, rather than reporting 0%', async () => {
      mockSite()
      fx.on('GET', '/v1/site-fci-history', () => fx.json(paginated([])))
      const result = await client.callTool({
        name: 'show_site_fci_trend',
        arguments: { site_id: SITE_ID },
      })
      expect((result.structuredContent as { latest: unknown }).latest).toBeNull()
      expect((result.content as TextContent[])[0].text).toContain('has no FCI readings')
    })

    it('passes a missing-scope 403 through with the scope named', async () => {
      mockSite()
      fx.on('GET', '/v1/site-fci-history', () =>
        fx.error(403, 'API key lacks required scope: site_fci_history:read')
      )
      const result = await client.callTool({
        name: 'show_site_fci_trend',
        arguments: { site_id: SITE_ID },
      })
      expect(result.isError).toBe(true)
      expect((result.content as TextContent[])[0].text).toContain('site_fci_history:read')
    })

    it('rejects a site_id that is not a UUID before any request is made', async () => {
      const result = await client.callTool({
        name: 'show_site_fci_trend',
        arguments: { site_id: 'Main Library' },
      })
      expect(result.isError).toBe(true)
      expect(fx.calls).toHaveLength(0)
    })
  })
})

// The canonical scale lives in the AssetLab app's source, next to this package in its monorepo.
// The public mirror of this package does not carry it, so the drift check runs only where it can.
const FCI_BANDS_SOURCE = resolve(__dirname, '../../../../src/lib/fci-bands.ts')

describe('MCP Apps: site FCI trend view', () => {
  it.skipIf(!existsSync(FCI_BANDS_SOURCE))(
    'uses the product-wide FCI bounds and colours from src/lib/fci-bands.ts',
    () => {
      const source = readFileSync(FCI_BANDS_SOURCE, 'utf8')
      const bounds = source.match(/FCI_BOUNDS = \{\s*good: ([\d.]+),\s*fair: ([\d.]+),/)
      expect(bounds, 'FCI_BOUNDS not found in fci-bands.ts').not.toBeNull()
      expect(FCI_GOOD_BOUND).toBe(Number(bounds?.[1]))
      expect(FCI_FAIR_BOUND).toBe(Number(bounds?.[2]))

      const colours = source.match(/FCI_BAND_COLORS[^{]*\{([^}]*)\}/)?.[1] ?? ''
      for (const [band, hex] of Object.entries(FCI_COLORS)) {
        expect(colours, `colour for ${band}`).toContain(`${band}: '${hex}'`)
      }
    }
  )

  it('loads nothing from the network, matching its empty CSP', () => {
    expect(SITE_FCI_TREND_HTML).not.toMatch(/<script[^>]+src=/i)
    expect(SITE_FCI_TREND_HTML).not.toMatch(/<link[^>]+href=/i)
    expect(SITE_FCI_TREND_HTML).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/)
    const urls = SITE_FCI_TREND_HTML.match(/https?:\/\/[^\s'"]+/g) ?? []
    expect(urls).toEqual(['http://www.w3.org/2000/svg'])
  })

  it('never writes tenant text as HTML', () => {
    expect(SITE_FCI_TREND_HTML).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write/
    )
  })
})
