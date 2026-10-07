// Asset condition assessments — MCP tool tests.
//
// Covers tool registration, list filter forwarding, required-field + enum + UUID
// validation, the create-only update_purchase_cost writeback flag, and that the
// trigger-owned previous_purchase_cost / create-only update_purchase_cost are never
// forwarded on update.

import type { McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { AssetLabClient } from '../../src/client.js'
import { withToolAnnotations } from '../../src/tool-annotations.js'
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
  registerWriteTools(withToolAnnotations(asMcpServer(server) as McpServer), client)
  return { server, fx }
}

const ASSET_ID = '550e8400-e29b-41d4-a716-446655440000'
const ID = '550e8400-e29b-41d4-a716-4466554400ff'

describe('Asset condition assessments — registration', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('registers the full CRUD surface', () => {
    for (const name of [
      'list_asset_condition_assessments',
      'get_asset_condition_assessment',
      'create_asset_condition_assessment',
      'update_asset_condition_assessment',
      'delete_asset_condition_assessment',
    ]) {
      expect(server.tools.has(name), `missing tool: ${name}`).toBe(true)
    }
  })
})

describe('Asset condition assessments — list', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('forwards asset_id, assessor_id, method, condition range, and date range', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/asset-condition-assessments', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_asset_condition_assessments', {
      asset_id: ASSET_ID,
      assessor_id: 'user_123',
      method: 'detailed',
      condition_min: 40,
      condition_max: 90,
      assessed_on_from: '2026-01-01',
      assessed_on_to: '2026-12-31',
    })
    expect(captured?.searchParams.get('asset_id')).toBe(ASSET_ID)
    expect(captured?.searchParams.get('assessor_id')).toBe('user_123')
    expect(captured?.searchParams.get('method')).toBe('detailed')
    expect(captured?.searchParams.get('condition_min')).toBe('40')
    expect(captured?.searchParams.get('condition_max')).toBe('90')
    expect(captured?.searchParams.get('assessed_on_from')).toBe('2026-01-01')
    expect(captured?.searchParams.get('assessed_on_to')).toBe('2026-12-31')
  })
})

describe('Asset condition assessments — create validation', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('requires asset_id and assessed_on', async () => {
    await expect(
      server.call('create_asset_condition_assessment', { assessed_on: '2026-05-28' })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects a malformed asset_id', async () => {
    await expect(
      server.call('create_asset_condition_assessment', {
        asset_id: 'not-a-uuid',
        assessed_on: '2026-05-28',
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects an unknown method', async () => {
    await expect(
      server.call('create_asset_condition_assessment', {
        asset_id: ASSET_ID,
        assessed_on: '2026-05-28',
        method: 'guesswork',
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects a condition_score outside 0-100', async () => {
    await expect(
      server.call('create_asset_condition_assessment', {
        asset_id: ASSET_ID,
        assessed_on: '2026-05-28',
        condition_score: 150,
      })
    ).rejects.toBeInstanceOf(ZodError)
  })
})

describe('Asset condition assessments — purchase-cost writeback flag', () => {
  let server: FakeMcpServer
  let fx: FetchFake
  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('forwards update_purchase_cost on create', async () => {
    let sent: Record<string, unknown> | undefined
    fx.on('POST', '/v1/asset-condition-assessments', ({ body }) => {
      sent = body as Record<string, unknown>
      return fx.json(single({ id: ID }), 201)
    })
    await server.call('create_asset_condition_assessment', {
      asset_id: ASSET_ID,
      assessed_on: '2026-05-28',
      replacement_cost: 12000,
      update_purchase_cost: true,
    })
    expect(sent?.update_purchase_cost).toBe(true)
    expect(sent?.replacement_cost).toBe(12000)
  })

  it('strips trigger-owned previous_purchase_cost from a create body', async () => {
    let sent: Record<string, unknown> | undefined
    fx.on('POST', '/v1/asset-condition-assessments', ({ body }) => {
      sent = body as Record<string, unknown>
      return fx.json(single({ id: ID }), 201)
    })
    await server.call('create_asset_condition_assessment', {
      asset_id: ASSET_ID,
      assessed_on: '2026-05-28',
      previous_purchase_cost: 999,
    })
    expect(sent?.previous_purchase_cost).toBeUndefined()
  })

  it('does not forward update_purchase_cost on update (create-only writeback)', async () => {
    let sent: Record<string, unknown> | undefined
    fx.on('PATCH', '/v1/asset-condition-assessments/' + ID, ({ body }) => {
      sent = body as Record<string, unknown>
      return fx.json(single({ id: ID }), 200)
    })
    await server.call('update_asset_condition_assessment', {
      id: ID,
      condition_score: 70,
      update_purchase_cost: true,
    })
    expect(sent?.condition_score).toBe(70)
    expect(sent?.update_purchase_cost).toBeUndefined()
  })
})
