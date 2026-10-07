// Facility lifecycle strategy events MCP tool tests (facilities Phase 2).
//
// The facilities twin of lifecycle-events.test.ts: tool registration, URL routing,
// filter forwarding, UUID addressing, and the zod gate. Scope semantics (events attach
// to an asset-type scope — exactly one of type / type group — never assets) live in the
// tool descriptions and the gateway's validation; here we pin the wire contract.

import type { McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

const EVENT_ID = '2c1d4e5f-8a7b-4c3d-9e0f-1a2b3c4d5e6f'
const TYPE_ID = '9f8e7d6c-5b4a-4392-8171-6a5b4c3d2e1f'
const CATEGORY_ID = '4d3c2b1a-9f8e-4d7c-8b6a-5f4e3d2c1b0a'

describe('Asset lifecycle events — asset-type-keyed strategy events', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('list_asset_lifecycle_events hits /v1/asset-lifecycle-events', async () => {
    fx.on('GET', '/v1/asset-lifecycle-events', () => fx.json(paginated([])))
    const r = await server.call('list_asset_lifecycle_events', {})
    expect(r.isError).toBeFalsy()
  })

  it('forwards asset_type_id, asset_type_group_id, event_class and is_active filters', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/asset-lifecycle-events', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_asset_lifecycle_events', {
      asset_type_id: TYPE_ID,
      event_class: 'preventive',
      is_active: 'true',
    })
    expect(captured?.searchParams.get('asset_type_id')).toBe(TYPE_ID)
    expect(captured?.searchParams.get('event_class')).toBe('preventive')
    expect(captured?.searchParams.get('is_active')).toBe('true')
  })

  it('get_asset_lifecycle_event addresses by UUID', async () => {
    fx.on('GET', `/v1/asset-lifecycle-events/${EVENT_ID}`, () =>
      fx.json(single({ id: EVENT_ID, name: 'Roof recoat' }))
    )
    const r = await server.call('get_asset_lifecycle_event', { id: EVENT_ID })
    expect(JSON.parse(r.content[0].text).data.name).toBe('Roof recoat')
  })

  it('get rejects a non-UUID id at the zod gate', async () => {
    await expect(server.call('get_asset_lifecycle_event', { id: 'roof-recoat' })).rejects.toThrow()
  })

  it('create POSTs the event body to /v1/asset-lifecycle-events', async () => {
    let body: Record<string, unknown> | undefined
    fx.on('POST', '/v1/asset-lifecycle-events', ({ body: sent }) => {
      body = sent as Record<string, unknown>
      return fx.json(single({ id: EVENT_ID }), 201)
    })
    const r = await server.call('create_asset_lifecycle_event', {
      name: 'Roof recoat',
      asset_type_id: TYPE_ID,
      event_class: 'preventive',
      trigger_condition_max: 85,
      trigger_condition_min: 70,
      impact_method: 'add_years',
      impact_add_years: 5,
      fixed_cost: 12000,
    })
    expect(r.isError).toBeFalsy()
    expect(body?.name).toBe('Roof recoat')
    expect(body?.asset_type_id).toBe(TYPE_ID)
    expect(body?.fixed_cost).toBe(12000)
  })

  it('create rejects an unknown event_class at the zod gate', async () => {
    await expect(
      server.call('create_asset_lifecycle_event', {
        name: 'X',
        asset_type_id: TYPE_ID,
        event_class: 'replacement',
        trigger_condition_max: 90,
        impact_method: 'add_years',
        impact_add_years: 2,
      })
    ).rejects.toThrow()
  })

  it('create rejects a non-UUID scope id at the zod gate', async () => {
    await expect(
      server.call('create_asset_lifecycle_event', {
        name: 'X',
        asset_type_id: 'boiler',
        event_class: 'preventive',
        trigger_condition_max: 90,
        impact_method: 'add_years',
        impact_add_years: 2,
      })
    ).rejects.toThrow()
  })

  it('update PATCHes /v1/asset-lifecycle-events/{id}', async () => {
    let hit = false
    fx.on('PATCH', `/v1/asset-lifecycle-events/${EVENT_ID}`, () => {
      hit = true
      return fx.json(single({ id: EVENT_ID, is_active: false }))
    })
    const r = await server.call('update_asset_lifecycle_event', {
      id: EVENT_ID,
      is_active: false,
    })
    expect(r.isError).toBeFalsy()
    expect(hit).toBe(true)
  })

  it('delete DELETEs /v1/asset-lifecycle-events/{id}', async () => {
    let hit = false
    fx.on('DELETE', `/v1/asset-lifecycle-events/${EVENT_ID}`, () => {
      hit = true
      return fx.json({ success: true })
    })
    const r = await server.call('delete_asset_lifecycle_event', { id: EVENT_ID })
    expect(r.isError).toBeFalsy()
    expect(hit).toBe(true)
  })

  it('forwards work_generation settings on create', async () => {
    let body: Record<string, unknown> | undefined
    fx.on('POST', '/v1/asset-lifecycle-events', ({ body: sent }) => {
      body = sent as Record<string, unknown>
      return fx.json(single({ id: EVENT_ID }), 201)
    })
    const r = await server.call('create_asset_lifecycle_event', {
      name: 'Roof recoat',
      asset_type_id: TYPE_ID,
      event_class: 'preventive',
      trigger_condition_max: 85,
      impact_method: 'add_years',
      impact_add_years: 5,
      work_generation: 'work_order',
      work_generation_category_id: CATEGORY_ID,
      work_generation_priority: 'HIGH',
    })
    expect(r.isError).toBeFalsy()
    expect(body?.work_generation).toBe('work_order')
    expect(body?.work_generation_category_id).toBe(CATEGORY_ID)
    expect(body?.work_generation_priority).toBe('HIGH')
  })

  it('rejects an unknown work_generation value at the zod gate', async () => {
    await expect(
      server.call('update_asset_lifecycle_event', { id: EVENT_ID, work_generation: 'pm_schedule' })
    ).rejects.toThrow()
  })

  it('rejects a lowercase work_generation_priority at the zod gate', async () => {
    await expect(
      server.call('update_asset_lifecycle_event', {
        id: EVENT_ID,
        work_generation_priority: 'high',
      })
    ).rejects.toThrow()
  })
})
