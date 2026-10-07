// Lifecycle strategy events MCP tool tests (Phase 2 of lifecycle strategies).
//
// Covers tool registration, URL routing, filter forwarding, UUID addressing, and the
// zod gate on enums/ranges. Scope semantics (events attach to class/material/band
// scopes, never features) live in the tool descriptions and the gateway's validation;
// here we pin the wire contract.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

const EVENT_ID = '7b0f2f6a-9f2f-4a52-9a8a-1c2d3e4f5a6b'

describe('Infrastructure lifecycle events — scope-keyed strategy events', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    ;({ server, fx } = bootstrap())
  })
  afterEach(() => fx.restore())

  it('list_infrastructure_lifecycle_events hits /v1/infrastructure-lifecycle-events', async () => {
    fx.on('GET', '/v1/infrastructure-lifecycle-events', () => fx.json(paginated([])))
    const r = await server.call('list_infrastructure_lifecycle_events', {})
    expect(r.isError).toBeFalsy()
  })

  it('forwards feature_class, material, event_class and is_active filters', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/infrastructure-lifecycle-events', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_infrastructure_lifecycle_events', {
      feature_class: 'sidewalk',
      material: 'Concrete',
      event_class: 'preventive',
      is_active: 'true',
    })
    expect(captured?.searchParams.get('feature_class')).toBe('sidewalk')
    expect(captured?.searchParams.get('material')).toBe('Concrete')
    expect(captured?.searchParams.get('event_class')).toBe('preventive')
    expect(captured?.searchParams.get('is_active')).toBe('true')
  })

  it('get_infrastructure_lifecycle_event addresses by UUID', async () => {
    fx.on('GET', `/v1/infrastructure-lifecycle-events/${EVENT_ID}`, () =>
      fx.json(single({ id: EVENT_ID, name: 'Crack Sealing' }))
    )
    const r = await server.call('get_infrastructure_lifecycle_event', { id: EVENT_ID })
    expect(JSON.parse(r.content[0].text).data.name).toBe('Crack Sealing')
  })

  it('get rejects a non-UUID id at the zod gate', async () => {
    await expect(
      server.call('get_infrastructure_lifecycle_event', { id: 'crack-sealing' })
    ).rejects.toThrow()
  })

  it('create POSTs the event body to /v1/infrastructure-lifecycle-events', async () => {
    let body: Record<string, unknown> | undefined
    fx.on('POST', '/v1/infrastructure-lifecycle-events', ({ body: sent }) => {
      body = sent as Record<string, unknown>
      return fx.json(single({ id: EVENT_ID }), 201)
    })
    const r = await server.call('create_infrastructure_lifecycle_event', {
      name: 'Crack Sealing',
      feature_class: 'sidewalk',
      material: 'Concrete',
      event_class: 'preventive',
      trigger_condition_max: 90,
      trigger_condition_min: 80,
      impact_method: 'add_years',
      impact_add_years: 2,
      unit_cost: 4,
    })
    expect(r.isError).toBeFalsy()
    expect(body?.name).toBe('Crack Sealing')
    expect(body?.trigger_condition_max).toBe(90)
    expect(body?.impact_method).toBe('add_years')
  })

  it('create rejects an unknown event_class at the zod gate', async () => {
    await expect(
      server.call('create_infrastructure_lifecycle_event', {
        name: 'X',
        feature_class: 'sidewalk',
        event_class: 'replacement',
        trigger_condition_max: 90,
        impact_method: 'add_years',
        impact_add_years: 2,
      })
    ).rejects.toThrow()
  })

  it('create rejects a trigger bound above 99 at the zod gate', async () => {
    await expect(
      server.call('create_infrastructure_lifecycle_event', {
        name: 'X',
        feature_class: 'sidewalk',
        event_class: 'preventive',
        trigger_condition_max: 100,
        impact_method: 'add_years',
        impact_add_years: 2,
      })
    ).rejects.toThrow()
  })

  it('update PATCHes /v1/infrastructure-lifecycle-events/{id}', async () => {
    let hit = false
    fx.on('PATCH', `/v1/infrastructure-lifecycle-events/${EVENT_ID}`, () => {
      hit = true
      return fx.json(single({ id: EVENT_ID, is_active: false }))
    })
    const r = await server.call('update_infrastructure_lifecycle_event', {
      id: EVENT_ID,
      is_active: false,
    })
    expect(r.isError).toBeFalsy()
    expect(hit).toBe(true)
  })

  it('delete DELETEs /v1/infrastructure-lifecycle-events/{id}', async () => {
    let hit = false
    fx.on('DELETE', `/v1/infrastructure-lifecycle-events/${EVENT_ID}`, () => {
      hit = true
      return fx.json({ success: true })
    })
    const r = await server.call('delete_infrastructure_lifecycle_event', { id: EVENT_ID })
    expect(r.isError).toBeFalsy()
    expect(hit).toBe(true)
  })
})
