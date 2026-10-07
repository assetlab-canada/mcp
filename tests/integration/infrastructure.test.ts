// Phase 4.5a — Infrastructure MCP tool tests.
//
// Covers tool registration, URL routing, addressing-by-code for feature classes,
// GeoJSON validation for features, and BULK_RESOURCES inclusion.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { AssetLabClient } from '../../src/client.js'
import { registerTools } from '../../src/tools.js'
import { registerWriteTools } from '../../src/tools-write.js'
import { apiKey, paginated, single } from '../fixtures/factories.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'
import { asMcpServer, FakeMcpServer } from '../fixtures/tool-harness.js'

function bootstrap(): { server: FakeMcpServer; fx: FetchFake } {
  const server = new FakeMcpServer()
  const fx = installFetchFake()
  const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
  registerTools(asMcpServer(server) as McpServer, client)
  registerWriteTools(asMcpServer(server) as McpServer, client)
  return { server, fx }
}

describe('Infrastructure feature classes — addressed by code (not UUID)', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('list_infrastructure_feature_classes hits /v1/infrastructure-feature-classes', async () => {
    fx.on('GET', '/v1/infrastructure-feature-classes', () => fx.json(paginated([])))
    const r = await server.call('list_infrastructure_feature_classes', {})
    expect(r.isError).toBeFalsy()
  })

  it('list_infrastructure_feature_classes forwards category + is_builtin filters', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/infrastructure-feature-classes', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_infrastructure_feature_classes', {
      category: 'stormwater',
      is_builtin: 'false',
    })
    expect(captured?.searchParams.get('category')).toBe('stormwater')
    expect(captured?.searchParams.get('is_builtin')).toBe('false')
  })

  it('get_infrastructure_feature_class uses code as path segment', async () => {
    fx.on('GET', '/v1/infrastructure-feature-classes/storm_sewer', () =>
      fx.json(single({ code: 'storm_sewer', label: 'Storm Sewer' }))
    )
    const r = await server.call('get_infrastructure_feature_class', { code: 'storm_sewer' })
    expect(JSON.parse(r.content[0].text).data.code).toBe('storm_sewer')
  })

  it('update_infrastructure_feature_class PATCHes /{code}, not /{id}', async () => {
    fx.on('PATCH', '/v1/infrastructure-feature-classes/water_main', ({ body }) =>
      fx.json(single({ code: 'water_main', ...(body as Record<string, unknown>) }))
    )
    const r = await server.call('update_infrastructure_feature_class', {
      code: 'water_main',
      label: 'Water Main (renamed)',
    })
    expect(JSON.parse(r.content[0].text).data.label).toBe('Water Main (renamed)')
  })

  it('delete_infrastructure_feature_class DELETEs /{code}', async () => {
    fx.on('DELETE', '/v1/infrastructure-feature-classes/gas_low_pressure', () =>
      fx.json({ success: true, message: 'Deleted' })
    )
    const r = await server.call('delete_infrastructure_feature_class', {
      code: 'gas_low_pressure',
    })
    expect(r.isError).toBeFalsy()
  })

  it('rejects codes that fail the regex (uppercase)', async () => {
    await expect(
      server.call('create_infrastructure_feature_class', {
        code: 'StormSewer',
        label: 'x',
        category: 'stormwater',
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects codes that start with a digit', async () => {
    await expect(
      server.call('create_infrastructure_feature_class', {
        code: '1sewer',
        label: 'x',
        category: 'stormwater',
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects unknown category enum values', async () => {
    await expect(
      server.call('create_infrastructure_feature_class', {
        code: 'foo',
        label: 'x',
        category: 'nonsense',
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('create_infrastructure_feature_class POSTs to /v1/infrastructure-feature-classes', async () => {
    let sentBody: Record<string, unknown> | undefined
    fx.on('POST', '/v1/infrastructure-feature-classes', ({ body }) => {
      sentBody = body as Record<string, unknown>
      return fx.json(single({ code: 'foo', label: 'Foo' }), 201)
    })
    await server.call('create_infrastructure_feature_class', {
      code: 'foo',
      label: 'Foo',
      category: 'other',
    })
    expect(sentBody?.code).toBe('foo')
    expect(sentBody?.category).toBe('other')
  })
})

describe('Infrastructure networks — UUID addressing + feature_class filter', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  const NET_ID = '550e8400-e29b-41d4-a716-446655440000'

  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('list_infrastructure_networks forwards feature_class code filter', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/infrastructure-networks', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_infrastructure_networks', { feature_class: 'water_main' })
    expect(captured?.searchParams.get('feature_class')).toBe('water_main')
  })

  it('create_infrastructure_network requires a valid feature_class code', async () => {
    fx.on('POST', '/v1/infrastructure-networks', ({ body }) =>
      fx.json(single({ id: NET_ID, ...(body as Record<string, unknown>) }), 201)
    )
    const r = await server.call('create_infrastructure_network', {
      name: 'Downtown Storm Network',
      feature_class: 'storm_sewer',
    })
    expect(JSON.parse(r.content[0].text).data.feature_class).toBe('storm_sewer')
  })

  it('rejects create_infrastructure_network with a malformed feature_class code', async () => {
    await expect(
      server.call('create_infrastructure_network', { name: 'x', feature_class: 'BAD-CODE' })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('update_infrastructure_network rejects non-UUID id', async () => {
    await expect(
      server.call('update_infrastructure_network', { id: 'not-a-uuid', name: 'x' })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('delete_infrastructure_network hits /v1/infrastructure-networks/{id}', async () => {
    fx.on('DELETE', `/v1/infrastructure-networks/${NET_ID}`, () =>
      fx.json({ success: true, message: 'Deleted' })
    )
    const r = await server.call('delete_infrastructure_network', { id: NET_ID })
    expect(r.isError).toBeFalsy()
  })
})

describe('Infrastructure assets (features) — GeoJSON validation', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  const NET_ID = '550e8400-e29b-41d4-a716-446655440000'

  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('accepts a Point geometry for a node', async () => {
    let sent: Record<string, unknown> | undefined
    fx.on('POST', '/v1/infrastructure-assets', ({ body }) => {
      sent = body as Record<string, unknown>
      return fx.json(single({ id: 'asset-1' }), 201)
    })
    await server.call('create_infrastructure_asset', {
      network_id: NET_ID,
      feature_type: 'node',
      geometry: { type: 'Point', coordinates: [-123.1207, 49.2827] },
    })
    expect(sent?.feature_type).toBe('node')
    expect((sent?.geometry as { type: string }).type).toBe('Point')
  })

  it('accepts a LineString geometry for a segment', async () => {
    fx.on('POST', '/v1/infrastructure-assets', () => fx.json(single({ id: 'asset-2' }), 201))
    const r = await server.call('create_infrastructure_asset', {
      network_id: NET_ID,
      feature_type: 'segment',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-123.1207, 49.2827],
          [-123.121, 49.283],
        ],
      },
    })
    expect(r.isError).toBeFalsy()
  })

  it('rejects a LineString with only one coordinate pair', async () => {
    await expect(
      server.call('create_infrastructure_asset', {
        network_id: NET_ID,
        feature_type: 'segment',
        geometry: { type: 'LineString', coordinates: [[-123.1207, 49.2827]] },
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects a geometry whose type is neither Point nor LineString', async () => {
    await expect(
      server.call('create_infrastructure_asset', {
        network_id: NET_ID,
        feature_type: 'node',
        geometry: { type: 'Polygon', coordinates: [[[0, 0]]] },
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects geometry coordinates that are not numeric pairs', async () => {
    await expect(
      server.call('create_infrastructure_asset', {
        network_id: NET_ID,
        feature_type: 'node',
        geometry: { type: 'Point', coordinates: ['lon', 'lat'] },
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects feature_type outside enum', async () => {
    await expect(
      server.call('create_infrastructure_asset', {
        network_id: NET_ID,
        feature_type: 'polygon',
        geometry: { type: 'Point', coordinates: [0, 0] },
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('list_infrastructure_assets forwards network_id + feature_type filters', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/infrastructure-assets', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_infrastructure_assets', {
      network_id: NET_ID,
      feature_type: 'segment',
    })
    expect(captured?.searchParams.get('network_id')).toBe(NET_ID)
    expect(captured?.searchParams.get('feature_type')).toBe('segment')
  })

  it('list_infrastructure_assets forwards condition/risk range + include_deleted filters', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/infrastructure-assets', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    const ASSET_TYPE_ID = '550e8400-e29b-41d4-a716-446655449999'
    await server.call('list_infrastructure_assets', {
      asset_type_id: ASSET_TYPE_ID,
      condition_min: 20,
      condition_max: 80,
      risk_score_min: 5,
      risk_score_max: 25,
      include_deleted: 'true',
    })
    expect(captured?.searchParams.get('asset_type_id')).toBe(ASSET_TYPE_ID)
    expect(captured?.searchParams.get('condition_min')).toBe('20')
    expect(captured?.searchParams.get('condition_max')).toBe('80')
    expect(captured?.searchParams.get('risk_score_min')).toBe('5')
    expect(captured?.searchParams.get('risk_score_max')).toBe('25')
    expect(captured?.searchParams.get('include_deleted')).toBe('true')
  })

  it('update_infrastructure_asset accepts a replacement geometry without feature_type', async () => {
    const ID = '550e8400-e29b-41d4-a716-446655440001'
    fx.on('PATCH', `/v1/infrastructure-assets/${ID}`, ({ body }) =>
      fx.json(single({ id: ID, ...(body as Record<string, unknown>) }))
    )
    const r = await server.call('update_infrastructure_asset', {
      id: ID,
      geometry: { type: 'Point', coordinates: [-123.0, 49.3] },
    })
    expect(r.isError).toBeFalsy()
  })

  it('update_infrastructure_asset rejects computed-column writes only at the server', async () => {
    // Computed columns (length_m, slope_pct, risk_score) are not in the zod schema,
    // so zod silently drops them. This mirrors the .strict()-free pattern used elsewhere.
    // The api-gateway is responsible for stripping/ignoring them. We assert the
    // request body excludes them when caller passes only known fields.
    const ID = '550e8400-e29b-41d4-a716-446655440002'
    let sent: Record<string, unknown> | undefined
    fx.on('PATCH', `/v1/infrastructure-assets/${ID}`, ({ body }) => {
      sent = body as Record<string, unknown>
      return fx.json(single({ id: ID }))
    })
    await server.call('update_infrastructure_asset', { id: ID, name: 'Pump A' })
    expect(sent?.name).toBe('Pump A')
    expect(sent?.length_m).toBeUndefined()
    expect(sent?.slope_pct).toBeUndefined()
    expect(sent?.risk_score).toBeUndefined()
  })
})

describe('Infrastructure asset inspections — UUID addressing + filters', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  const FEATURE_ID = '550e8400-e29b-41d4-a716-446655440000'

  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('list_infrastructure_asset_inspections forwards feature_id, date range, method + condition range', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/infrastructure-asset-inspections', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_infrastructure_asset_inspections', {
      feature_id: FEATURE_ID,
      inspection_date_from: '2026-01-01',
      inspection_date_to: '2026-12-31',
      method: 'CCTV',
      condition_min: 10,
      condition_max: 90,
    })
    expect(captured?.searchParams.get('feature_id')).toBe(FEATURE_ID)
    expect(captured?.searchParams.get('inspection_date_from')).toBe('2026-01-01')
    expect(captured?.searchParams.get('inspection_date_to')).toBe('2026-12-31')
    expect(captured?.searchParams.get('method')).toBe('CCTV')
    expect(captured?.searchParams.get('condition_min')).toBe('10')
    expect(captured?.searchParams.get('condition_max')).toBe('90')
  })

  it('create_infrastructure_asset_inspection requires feature_id + inspection_date', async () => {
    fx.on('POST', '/v1/infrastructure-asset-inspections', ({ body }) =>
      fx.json(single({ id: 'insp-1', ...(body as Record<string, unknown>) }), 201)
    )
    const r = await server.call('create_infrastructure_asset_inspection', {
      feature_id: FEATURE_ID,
      inspection_date: '2026-05-28',
      condition_score: 72,
    })
    const data = JSON.parse(r.content[0].text).data
    expect(data.feature_id).toBe(FEATURE_ID)
    expect(data.condition_score).toBe(72)
  })

  it('rejects create_infrastructure_asset_inspection with malformed feature_id', async () => {
    await expect(
      server.call('create_infrastructure_asset_inspection', {
        feature_id: 'not-a-uuid',
        inspection_date: '2026-05-28',
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects condition_score outside 0-100', async () => {
    await expect(
      server.call('create_infrastructure_asset_inspection', {
        feature_id: FEATURE_ID,
        inspection_date: '2026-05-28',
        condition_score: 150,
      })
    ).rejects.toBeInstanceOf(ZodError)
  })
})

describe('Infrastructure — bulk_create coverage', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('bulk_create accepts infrastructure-assets resource (BULK_RESOURCES regression)', async () => {
    fx.on('POST', '/v1/infrastructure-assets/bulk', () =>
      fx.json({ data: { successful: [], failed: [] } }, 201)
    )
    const r = await server.call('bulk_create', {
      resource: 'infrastructure-assets',
      items: [
        {
          network_id: '550e8400-e29b-41d4-a716-446655440000',
          feature_type: 'node',
          geometry: { type: 'Point', coordinates: [-123, 49] },
        },
      ],
    })
    expect(r.isError).toBeFalsy()
  })

  it('bulk_create rejects unknown infrastructure resource', async () => {
    await expect(
      server.call('bulk_create', {
        resource: 'infrastructure-networks',
        items: [{ name: 'x', feature_class: 'storm_sewer' }],
      })
    ).rejects.toBeInstanceOf(ZodError)
  })
})

describe('Infrastructure — tool registration completeness', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('registers all 20 infrastructure tools (8 read + 12 write)', () => {
    const names = [
      'list_infrastructure_feature_classes',
      'get_infrastructure_feature_class',
      'list_infrastructure_networks',
      'get_infrastructure_network',
      'list_infrastructure_assets',
      'get_infrastructure_asset',
      'list_infrastructure_asset_inspections',
      'get_infrastructure_asset_inspection',
      'create_infrastructure_feature_class',
      'update_infrastructure_feature_class',
      'delete_infrastructure_feature_class',
      'create_infrastructure_network',
      'update_infrastructure_network',
      'delete_infrastructure_network',
      'create_infrastructure_asset',
      'update_infrastructure_asset',
      'delete_infrastructure_asset',
      'create_infrastructure_asset_inspection',
      'update_infrastructure_asset_inspection',
      'delete_infrastructure_asset_inspection',
    ]
    for (const name of names) {
      expect(server.tools.has(name), `missing tool: ${name}`).toBe(true)
    }
  })
})
