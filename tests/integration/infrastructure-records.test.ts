// Phase 4.5b — Infrastructure attached-record MCP tool tests.
//
// Covers tool registration, URL routing + filter forwarding, GeoJSON Polygon
// validation for zones, comment user_id stripping, cost work_order_number
// stripping, and the read-only nature of risk history.

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

const FEATURE_ID = '550e8400-e29b-41d4-a716-446655440000'
const NET_ID = '550e8400-e29b-41d4-a716-446655440001'
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002'
const PART_ID = '550e8400-e29b-41d4-a716-446655440003'
const ID = '550e8400-e29b-41d4-a716-4466554400ff'

describe('Infrastructure asset costs', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('list forwards feature_id, work_order_id, category, and date range', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/infrastructure-asset-costs', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_infrastructure_asset_costs', {
      feature_id: FEATURE_ID,
      work_order_id: NET_ID,
      category: 'Repair',
      cost_date_from: '2026-01-01',
      cost_date_to: '2026-12-31',
    })
    expect(captured?.searchParams.get('feature_id')).toBe(FEATURE_ID)
    expect(captured?.searchParams.get('work_order_id')).toBe(NET_ID)
    expect(captured?.searchParams.get('category')).toBe('Repair')
    expect(captured?.searchParams.get('cost_date_from')).toBe('2026-01-01')
    expect(captured?.searchParams.get('cost_date_to')).toBe('2026-12-31')
  })

  it('create rejects an invalid category enum', async () => {
    await expect(
      server.call('create_infrastructure_asset_cost', {
        feature_id: FEATURE_ID,
        category: 'NotARealCategory',
        amount: 100,
        cost_date: '2026-05-28',
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('create drops work_order_number (server-stamped)', async () => {
    let sent: Record<string, unknown> | undefined
    fx.on('POST', '/v1/infrastructure-asset-costs', ({ body }) => {
      sent = body as Record<string, unknown>
      return fx.json(single({ id: ID }), 201)
    })
    await server.call('create_infrastructure_asset_cost', {
      feature_id: FEATURE_ID,
      category: 'PM',
      amount: 250.5,
      cost_date: '2026-05-28',
      work_order_number: 9999,
    })
    expect(sent?.amount).toBe(250.5)
    expect(sent?.work_order_number).toBeUndefined()
  })
})

describe('Infrastructure asset parts', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('create requires feature_id + part_id', async () => {
    fx.on('POST', '/v1/infrastructure-asset-parts', ({ body }) =>
      fx.json(single({ id: ID, ...(body as Record<string, unknown>) }), 201)
    )
    const r = await server.call('create_infrastructure_asset_part', {
      feature_id: FEATURE_ID,
      part_id: PART_ID,
      quantity: 3,
    })
    expect(JSON.parse(r.content[0].text).data.part_id).toBe(PART_ID)
  })

  it('rejects a malformed part_id', async () => {
    await expect(
      server.call('create_infrastructure_asset_part', {
        feature_id: FEATURE_ID,
        part_id: 'not-a-uuid',
      })
    ).rejects.toBeInstanceOf(ZodError)
  })
})

describe('Infrastructure asset documents', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('list forwards feature_id, category, and search', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/infrastructure-asset-documents', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_infrastructure_asset_documents', {
      feature_id: FEATURE_ID,
      category: 'warranty',
      search: 'spec',
    })
    expect(captured?.searchParams.get('feature_id')).toBe(FEATURE_ID)
    expect(captured?.searchParams.get('category')).toBe('warranty')
    expect(captured?.searchParams.get('search')).toBe('spec')
  })

  it('create requires feature_id, name, and file_path', async () => {
    await expect(
      server.call('create_infrastructure_asset_document', {
        feature_id: FEATURE_ID,
        name: 'Spec sheet',
      })
    ).rejects.toBeInstanceOf(ZodError)
  })
})

describe('Infrastructure asset comments', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('create does not forward a client-supplied user_id (attributed to the key server-side)', async () => {
    let sent: Record<string, unknown> | undefined
    fx.on('POST', '/v1/infrastructure-asset-comments', ({ body }) => {
      sent = body as Record<string, unknown>
      return fx.json(single({ id: ID }), 201)
    })
    await server.call('create_infrastructure_asset_comment', {
      feature_id: FEATURE_ID,
      comment: 'Looks corroded',
      user_id: 'user_spoofed',
    })
    expect(sent?.comment).toBe('Looks corroded')
    expect(sent?.user_id).toBeUndefined()
  })
})

describe('Infrastructure zones — GeoJSON Polygon validation', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  const POLY = {
    type: 'Polygon' as const,
    coordinates: [
      [
        [-123.12, 49.28],
        [-123.11, 49.28],
        [-123.11, 49.29],
        [-123.12, 49.28],
      ],
    ],
  }
  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('accepts a Polygon boundary', async () => {
    let sent: Record<string, unknown> | undefined
    fx.on('POST', '/v1/infrastructure-zones', ({ body }) => {
      sent = body as Record<string, unknown>
      return fx.json(single({ id: ID }), 201)
    })
    await server.call('create_infrastructure_zone', {
      network_id: NET_ID,
      kind: 'dma',
      name: 'DMA-1',
      boundary: POLY,
    })
    expect((sent?.boundary as { type: string }).type).toBe('Polygon')
  })

  it('forwards a MultiPolygon boundary intact', async () => {
    // The zones column is geography(MultiPolygon,4326) since 2026-09-01; a
    // sewershed with an island has no single-Polygon form, and the tool used to
    // reject it outright.
    let sent: Record<string, unknown> | undefined
    fx.on('POST', '/v1/infrastructure-zones', ({ body }) => {
      sent = body as Record<string, unknown>
      return fx.json(single({ id: ID }), 201)
    })
    const multi = {
      type: 'MultiPolygon' as const,
      coordinates: [POLY.coordinates, POLY.coordinates],
    }
    await server.call('create_infrastructure_zone', {
      network_id: NET_ID,
      kind: 'dma',
      name: 'DMA-2',
      boundary: multi,
    })
    const boundary = sent?.boundary as { type: string; coordinates: unknown[] }
    expect(boundary.type).toBe('MultiPolygon')
    expect(boundary.coordinates).toHaveLength(2)
  })

  it('still rejects a boundary that is neither Polygon nor MultiPolygon', async () => {
    await expect(
      server.call('create_infrastructure_zone', {
        network_id: NET_ID,
        kind: 'dma',
        name: 'DMA-2b',
        boundary: { type: 'Point', coordinates: [0, 0] },
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects an unknown kind', async () => {
    await expect(
      server.call('create_infrastructure_zone', {
        network_id: NET_ID,
        kind: 'nonsense',
        name: 'DMA-3',
        boundary: POLY,
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('list forwards network_id + kind', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/infrastructure-zones', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_infrastructure_zones', { network_id: NET_ID, kind: 'sewershed' })
    expect(captured?.searchParams.get('network_id')).toBe(NET_ID)
    expect(captured?.searchParams.get('kind')).toBe('sewershed')
  })
})

describe('Project ↔ infrastructure asset links', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('list forwards project_id + feature_id', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/project-infrastructure-assets', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_project_infrastructure_assets', {
      project_id: PROJECT_ID,
      feature_id: FEATURE_ID,
    })
    expect(captured?.searchParams.get('project_id')).toBe(PROJECT_ID)
    expect(captured?.searchParams.get('feature_id')).toBe(FEATURE_ID)
  })

  it('create requires project_id + feature_id', async () => {
    await expect(
      server.call('create_project_infrastructure_asset', { project_id: PROJECT_ID })
    ).rejects.toBeInstanceOf(ZodError)
  })
})

describe('Infrastructure asset risk history — read-only', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('list forwards feature_id, source, and capture date range', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/infrastructure-asset-risk-history', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_infrastructure_asset_risk_history', {
      feature_id: FEATURE_ID,
      source: 'manual_update',
      captured_at_from: '2026-01-01',
      captured_at_to: '2026-12-31',
    })
    expect(captured?.searchParams.get('feature_id')).toBe(FEATURE_ID)
    expect(captured?.searchParams.get('source')).toBe('manual_update')
    expect(captured?.searchParams.get('captured_at_from')).toBe('2026-01-01')
    expect(captured?.searchParams.get('captured_at_to')).toBe('2026-12-31')
  })

  it('exposes no create/update/delete tools', () => {
    expect(server.tools.has('create_infrastructure_asset_risk_history_entry')).toBe(false)
    expect(server.tools.has('update_infrastructure_asset_risk_history_entry')).toBe(false)
    expect(server.tools.has('delete_infrastructure_asset_risk_history_entry')).toBe(false)
  })
})

describe('Infrastructure 4.5b — tool registration completeness', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('registers all 32 attached-record tools (14 read + 18 write)', () => {
    const names = [
      // read
      'list_infrastructure_asset_costs',
      'get_infrastructure_asset_cost',
      'list_infrastructure_asset_parts',
      'get_infrastructure_asset_part',
      'list_infrastructure_asset_documents',
      'get_infrastructure_asset_document',
      'list_infrastructure_asset_comments',
      'get_infrastructure_asset_comment',
      'list_infrastructure_zones',
      'get_infrastructure_zone',
      'list_project_infrastructure_assets',
      'get_project_infrastructure_asset',
      'list_infrastructure_asset_risk_history',
      'get_infrastructure_asset_risk_history_entry',
      // write
      'create_infrastructure_asset_cost',
      'update_infrastructure_asset_cost',
      'delete_infrastructure_asset_cost',
      'create_infrastructure_asset_part',
      'update_infrastructure_asset_part',
      'delete_infrastructure_asset_part',
      'create_infrastructure_asset_document',
      'update_infrastructure_asset_document',
      'delete_infrastructure_asset_document',
      'create_infrastructure_asset_comment',
      'update_infrastructure_asset_comment',
      'delete_infrastructure_asset_comment',
      'create_infrastructure_zone',
      'update_infrastructure_zone',
      'delete_infrastructure_zone',
      'create_project_infrastructure_asset',
      'update_project_infrastructure_asset',
      'delete_project_infrastructure_asset',
    ]
    for (const name of names) {
      expect(server.tools.has(name), `missing tool: ${name}`).toBe(true)
    }
  })
})
