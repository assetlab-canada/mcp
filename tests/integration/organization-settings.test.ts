// get_organization_settings - F-220.
//
// This tool exists so an assistant can state a monetary amount without guessing
// the currency. The tests therefore pin the two things that make it useful: it
// reaches the singleton route, and a 403 for the missing scope arrives as text
// the caller can act on rather than a flattened generic failure.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssetLabClient } from '../../src/client.js'
import { registerTools } from '../../src/tools.js'
import { apiKey, single } from '../fixtures/factories.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'
import { asMcpServer, FakeMcpServer } from '../fixtures/tool-harness.js'

describe('get_organization_settings', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('is registered and takes no arguments', () => {
    const tool = server.tools.get('get_organization_settings')
    expect(tool).toBeDefined()
    expect(Object.keys(tool?.schema ?? {})).toEqual([])
  })

  it('returns the currency the caller needs before stating an amount', async () => {
    fx.on('GET', '/v1/organization-settings', () =>
      fx.json(
        single({
          company_name: 'City of Maplewood',
          currency_code: 'CAD',
          timezone: 'America/Toronto',
        })
      )
    )
    const r = await server.call('get_organization_settings', {})
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(r.content[0].text).data.currency_code).toBe('CAD')
  })

  it('reaches the singleton route, not a collection', async () => {
    let seen = ''
    fx.on('GET', '/v1/organization-settings', req => {
      seen = new URL(req.url).pathname
      return fx.json(single({ currency_code: 'USD' }))
    })
    await server.call('get_organization_settings', {})
    expect(seen).toBe('/v1/organization-settings')
  })

  it('surfaces a missing-scope 403 as actionable text rather than a generic failure', async () => {
    fx.on('GET', '/v1/organization-settings', () =>
      fx.json({ error: 'API key lacks required scope: organization_settings:read' }, 403)
    )
    const r = await server.call('get_organization_settings', {})
    expect(r.isError).toBe(true)
    // The scope name must survive to the model: SERVER_INSTRUCTIONS rule 5 tells it
    // to name the scope, which it cannot do if the client flattens the message.
    expect(r.content[0].text).toContain('organization_settings:read')
  })

  it('describes the currency problem it exists to solve', () => {
    const d = server.tools.get('get_organization_settings')?.description ?? ''
    expect(d).toContain('currency_code')
    expect(d.toLowerCase()).toContain('before')
  })
})
