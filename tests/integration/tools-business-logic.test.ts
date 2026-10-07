// Business-logic happy-path tests for representative tools across each domain.
//
// Each test:
//  1. Registers all tools against a fake MCP server.
//  2. Stubs the API gateway's HTTP response.
//  3. Invokes the tool through the same path the real transport would.
//  4. Asserts the request shape AND that the response is wrapped per MCP spec.

import type { McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssetLabClient } from '../../src/client.js'
import { registerTools } from '../../src/tools.js'
import {
  apiKey,
  asset,
  paginated,
  project,
  single,
  site,
  workOrder,
} from '../fixtures/factories.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'
import { asMcpServer, FakeMcpServer } from '../fixtures/tool-harness.js'

describe('Business logic — assets domain', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('list_assets returns text content wrapping JSON', async () => {
    const a = asset({ name: 'Main Boiler' })
    fx.on('GET', '/v1/assets', () => fx.json(paginated([a])))
    const r = await server.call('list_assets', {})
    expect(r.content[0].type).toBe('text')
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed.data[0].name).toBe('Main Boiler')
  })

  it('list_assets forwards filters to API gateway', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/assets', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_assets', {
      site_id: '550e8400-e29b-41d4-a716-446655440000',
      building_id: '550e8400-e29b-41d4-a716-446655440001',
      search: 'pump',
    })
    expect(captured?.searchParams.get('site_id')).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(captured?.searchParams.get('building_id')).toBe('550e8400-e29b-41d4-a716-446655440001')
    expect(captured?.searchParams.get('search')).toBe('pump')
  })

  it('get_asset hits /v1/assets/{id}', async () => {
    fx.on('GET', /^\/v1\/assets\/[0-9a-f-]+$/, ({ url }) =>
      fx.json(single(asset({ id: url.pathname.split('/').pop() })))
    )
    const r = await server.call('get_asset', { id: '550e8400-e29b-41d4-a716-446655440000' })
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed.data.id).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('create_asset POSTs to /v1/assets with provided fields', async () => {
    fx.on('POST', '/v1/assets', ({ body }) =>
      fx.json(single({ ...(body as Record<string, unknown>), id: 'new' }), 201)
    )
    const r = await server.call('create_asset', {
      name: 'Compressor #4',
      risk_factor: 'HIGH',
      condition_score: 60,
    })
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed.data.name).toBe('Compressor #4')
    expect(parsed.data.risk_factor).toBe('HIGH')
  })

  it('update_asset strips undefined fields (only changed fields are sent)', async () => {
    let sentBody: Record<string, unknown> | undefined
    fx.on('PATCH', '/v1/assets/550e8400-e29b-41d4-a716-446655440000', ({ body }) => {
      sentBody = body as Record<string, unknown>
      return fx.json(single(asset({ id: '550e8400-e29b-41d4-a716-446655440000' })))
    })
    await server.call('update_asset', {
      id: '550e8400-e29b-41d4-a716-446655440000',
      condition_score: 50,
    })
    expect(sentBody?.condition_score).toBe(50)
    expect(Object.keys(sentBody ?? {})).toEqual(['condition_score'])
  })

  it('delete_asset DELETEs /v1/assets/{id}', async () => {
    fx.on('DELETE', '/v1/assets/550e8400-e29b-41d4-a716-446655440000', () =>
      fx.json({ success: true, message: 'Deleted' })
    )
    const r = await server.call('delete_asset', { id: '550e8400-e29b-41d4-a716-446655440000' })
    expect(r.isError).toBeFalsy()
    expect(r.content[0].text).toContain('Deleted')
  })
})

describe('Business logic — work orders domain', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('list_work_orders maps resource path correctly (hyphenated URL)', async () => {
    fx.on('GET', '/v1/work-orders', () => fx.json(paginated([workOrder()])))
    const r = await server.call('list_work_orders', {})
    expect(JSON.parse(r.content[0].text).data).toHaveLength(1)
  })

  it('create_work_order POSTs to /v1/work-orders', async () => {
    fx.on('POST', '/v1/work-orders', ({ body }) =>
      fx.json(single({ ...(body as Record<string, unknown>), id: 'wo-1' }), 201)
    )
    const r = await server.call('create_work_order', {
      title: 'Fix HVAC',
      priority: 'HIGH',
      type: 'REACTIVE',
    })
    const data = JSON.parse(r.content[0].text).data
    expect(data.title).toBe('Fix HVAC')
    expect(data.priority).toBe('HIGH')
  })
})

describe('Business logic — sites/buildings/locations hierarchy', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('list_buildings filters by site_id', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/buildings', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_buildings', { site_id: '550e8400-e29b-41d4-a716-446655440000' })
    expect(captured?.searchParams.get('site_id')).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('list_locations filters by building_id', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/locations', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_locations', { building_id: '550e8400-e29b-41d4-a716-446655440000' })
    expect(captured?.searchParams.get('building_id')).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('list_sites includes city filter', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/sites', ({ url }) => {
      captured = url
      return fx.json(paginated([site()]))
    })
    await server.call('list_sites', { city: 'Vancouver' })
    expect(captured?.searchParams.get('city')).toBe('Vancouver')
  })
})

describe('Business logic — system hierarchy', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('list_system_groups filters by system_class_id', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/system-groups', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_system_groups', {
      system_class_id: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(captured?.searchParams.get('system_class_id')).toBe(
      '550e8400-e29b-41d4-a716-446655440000'
    )
  })

  it('list_systems filters by system_group_id', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/systems', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_systems', { system_group_id: '550e8400-e29b-41d4-a716-446655440000' })
    expect(captured?.searchParams.get('system_group_id')).toBe(
      '550e8400-e29b-41d4-a716-446655440000'
    )
  })
})

describe('Business logic — PM schedules', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('list_pm_schedules forwards frequency filter', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/pm-schedules', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_pm_schedules', { frequency: 'MONTHLY' })
    expect(captured?.searchParams.get('frequency')).toBe('MONTHLY')
  })
})

describe('Business logic — projects', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('list_projects forwards health_status filter', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/projects', ({ url }) => {
      captured = url
      return fx.json(paginated([project()]))
    })
    await server.call('list_projects', { health_status: 'at_risk' })
    expect(captured?.searchParams.get('health_status')).toBe('at_risk')
  })
})

describe('Business logic — contracts & compliance', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })
  afterEach(() => fx.restore())

  it('list_contracts forwards category filter', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/contracts', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_contracts', { category: 'electrical' })
    expect(captured?.searchParams.get('category')).toBe('electrical')
  })

  it('list_compliance_items maps to /v1/compliance', async () => {
    fx.on('GET', '/v1/compliance', () => fx.json(paginated([])))
    const r = await server.call('list_compliance_items', {})
    expect(r.isError).toBeFalsy()
  })
})
