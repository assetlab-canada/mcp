// Level of Service v2 engine - MCP tool tests.
//
// Covers registration of the 22 tools, that los-status-snapshots has no write tools, filter
// forwarding, required-field + enum + range + UUID validation, that a create never forwards a
// direction, nullable fields surviving to the wire, and the bulk allowlist staying closed.

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

const SYSTEM_ID = '550e8400-e29b-41d4-a716-446655440000'
const ID = '550e8400-e29b-41d4-a716-4466554400ff'

const WRITABLE = [
  ['system_los_target', 'system-los-targets'],
  ['infrastructure_los_target', 'infrastructure-los-targets'],
  ['criticality_modifier', 'criticality-modifiers'],
  ['los_consequence', 'los-consequences'],
] as const

let server: FakeMcpServer
let fx: FetchFake
beforeEach(() => {
  ;({ server, fx } = bootstrap())
})
afterEach(() => fx.restore())

function captureBody(method: 'POST' | 'PATCH', path: string): () => Record<string, unknown> {
  let sent: Record<string, unknown> | undefined
  fx.on(method, path, ({ body }) => {
    sent = body as Record<string, unknown>
    return fx.json(single({ id: ID }), method === 'POST' ? 201 : 200)
  })
  return () => sent ?? {}
}

describe('LoS engine - registration', () => {
  it.each(WRITABLE)('registers the full CRUD surface for %s', singular => {
    for (const name of [
      `list_${singular}s`,
      `get_${singular}`,
      `create_${singular}`,
      `update_${singular}`,
      `delete_${singular}`,
    ]) {
      expect(server.tools.has(name), `missing tool: ${name}`).toBe(true)
    }
  })

  it('exposes status snapshots as read-only', () => {
    expect(server.tools.has('list_los_status_snapshots')).toBe(true)
    expect(server.tools.has('get_los_status_snapshot')).toBe(true)
    for (const verb of ['create', 'update', 'delete']) {
      expect(server.tools.has(`${verb}_los_status_snapshot`)).toBe(false)
    }
  })

  it('keeps every new resource out of the bulk allowlist', async () => {
    for (const [, resource] of [...WRITABLE, ['', 'los-status-snapshots'] as const]) {
      await expect(
        server.call('bulk_create', { resource, items: [{ metric: 'fci' }] })
      ).rejects.toBeInstanceOf(ZodError)
    }
  })

  it.each(WRITABLE)('%s: get, update and delete reject a malformed id', async singular => {
    for (const verb of ['get', 'update', 'delete']) {
      await expect(server.call(`${verb}_${singular}`, { id: 'not-a-uuid' })).rejects.toBeInstanceOf(
        ZodError
      )
    }
  })

  it('says in the description what a caller could not guess', () => {
    const describes = (tool: string, text: string) =>
      expect(server.tools.get(tool)?.description, tool).toContain(text)
    describes('list_system_los_targets', '0-25')
    describes('create_system_los_target', 'condition 70 becomes 82')
    describes('create_infrastructure_los_target', 'Average risk is not available')
    describes('list_criticality_modifiers', 'critical 0.6, high 0.8, medium 1.0, low 1.4')
    describes('delete_criticality_modifier', 'restores the built-in default')
    describes('create_los_consequence', 'no notification is sent')
    describes('list_los_status_snapshots', 'not fractions')
    describes('list_los_targets_history', '2026-09-20')
  })
})

describe('LoS engine - list filters', () => {
  it('forwards system target filters, with active as a string', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/system-los-targets', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_system_los_targets', {
      system_id: SYSTEM_ID,
      metric: 'risk_score_avg',
      active: false,
    })
    expect(captured?.searchParams.get('system_id')).toBe(SYSTEM_ID)
    expect(captured?.searchParams.get('metric')).toBe('risk_score_avg')
    expect(captured?.searchParams.get('active')).toBe('false')
  })

  it('forwards snapshot subject, metric and period filters', async () => {
    let captured: URL | undefined
    fx.on('GET', '/v1/los-status-snapshots', ({ url }) => {
      captured = url
      return fx.json(paginated([]))
    })
    await server.call('list_los_status_snapshots', {
      network_id: SYSTEM_ID,
      metric: 'fci',
      period_from: '2026-01-01',
      period_to: '2026-09-01',
    })
    expect(captured?.searchParams.get('network_id')).toBe(SYSTEM_ID)
    expect(captured?.searchParams.get('metric')).toBe('fci')
    expect(captured?.searchParams.get('period_from')).toBe('2026-01-01')
    expect(captured?.searchParams.get('period_to')).toBe('2026-09-01')
  })

  it('rejects a malformed filter before any request is made', async () => {
    for (const [tool, args] of [
      ['list_system_los_targets', { system_id: 'not-a-uuid' }],
      ['list_system_los_targets', { metric: 'pm_compliance_rate' }],
      ['list_infrastructure_los_targets', { metric: 'risk_score_avg' }],
      ['list_criticality_modifiers', { criticality: 'urgent' }],
      ['list_los_status_snapshots', { building_id: 'not-a-uuid' }],
      ['list_los_status_snapshots', { period_from: 'September' }],
    ] as const) {
      await expect(server.call(tool, args), tool).rejects.toBeInstanceOf(ZodError)
    }
    expect(fx.calls.length).toBe(0)
  })
})

describe('LoS engine - system targets', () => {
  it('requires system_id, metric and base_target', async () => {
    for (const args of [
      { metric: 'fci', base_target: 10 },
      { system_id: SYSTEM_ID, base_target: 10 },
      { system_id: SYSTEM_ID, metric: 'fci' },
    ]) {
      await expect(server.call('create_system_los_target', args)).rejects.toBeInstanceOf(ZodError)
    }
  })

  it('rejects a malformed system_id, an unknown metric and an off-scale target', async () => {
    for (const args of [
      { system_id: 'not-a-uuid', metric: 'fci', base_target: 10 },
      { system_id: SYSTEM_ID, metric: 'pm_compliance_rate', base_target: 10 },
      { system_id: SYSTEM_ID, metric: 'fci', base_target: 101 },
      { system_id: SYSTEM_ID, metric: 'fci', base_target: -1 },
    ]) {
      await expect(server.call('create_system_los_target', args)).rejects.toBeInstanceOf(ZodError)
    }
  })

  it('never forwards a direction: the gateway derives it from the metric', async () => {
    const sent = captureBody('POST', '/v1/system-los-targets')
    await server.call('create_system_los_target', {
      system_id: SYSTEM_ID,
      metric: 'asset_condition_avg',
      base_target: 70,
      direction: 'lower_is_better',
    })
    expect(sent()).toEqual({ system_id: SYSTEM_ID, metric: 'asset_condition_avg', base_target: 70 })
  })

  it('points the caller at list_systems for the id', () => {
    const schema = server.tools.get('create_system_los_target')?.schema
    expect(schema?.system_id.description).toContain('list_systems')
    expect(schema?.system_id.description).toContain('(required)')
  })
})

describe('LoS engine - infrastructure targets', () => {
  it('requires feature_class, metric and base_target', async () => {
    for (const args of [
      { metric: 'fci', base_target: 10 },
      { feature_class: 'sidewalk', base_target: 10 },
      { feature_class: 'sidewalk', metric: 'fci' },
    ]) {
      await expect(server.call('create_infrastructure_los_target', args)).rejects.toBeInstanceOf(
        ZodError
      )
    }
  })

  it('rejects average risk and a feature class that is not a code', async () => {
    for (const args of [
      { feature_class: 'sidewalk', metric: 'risk_score_avg', base_target: 10 },
      { feature_class: 'Side Walk', metric: 'fci', base_target: 10 },
    ]) {
      await expect(server.call('create_infrastructure_los_target', args)).rejects.toBeInstanceOf(
        ZodError
      )
    }
  })

  it('points the caller at list_infrastructure_feature_classes for the code', () => {
    const schema = server.tools.get('create_infrastructure_los_target')?.schema
    expect(schema?.feature_class.description).toContain('list_infrastructure_feature_classes')
  })
})

describe('LoS engine - criticality modifiers', () => {
  it('requires criticality and modifier', async () => {
    await expect(
      server.call('create_criticality_modifier', { modifier: 0.5 })
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      server.call('create_criticality_modifier', { criticality: 'high' })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('holds modifier to 0.1-1.9 on create and update', async () => {
    for (const modifier of [2, 0.05, 0]) {
      await expect(
        server.call('create_criticality_modifier', { criticality: 'high', modifier })
      ).rejects.toBeInstanceOf(ZodError)
      await expect(
        server.call('update_criticality_modifier', { id: ID, modifier })
      ).rejects.toBeInstanceOf(ZodError)
    }
  })

  it('accepts both ends of the range', async () => {
    const sent = captureBody('POST', '/v1/criticality-modifiers')
    await server.call('create_criticality_modifier', { criticality: 'low', modifier: 1.9 })
    expect(sent()).toEqual({ criticality: 'low', modifier: 1.9 })
    await server.call('create_criticality_modifier', { criticality: 'critical', modifier: 0.1 })
    expect(sent()).toEqual({ criticality: 'critical', modifier: 0.1 })
  })
})

describe('LoS engine - consequences', () => {
  const base = { scope_type: 'global', statement: 'Flag for budget review.', severity: 'warning' }

  it('requires scope_type, statement and severity', async () => {
    for (const missing of ['scope_type', 'statement', 'severity'] as const) {
      const { [missing]: _omitted, ...args } = base
      await expect(server.call('create_los_consequence', args), missing).rejects.toBeInstanceOf(
        ZodError
      )
    }
  })

  it('rejects an unknown scope type, severity, metric and notify role', async () => {
    for (const patch of [
      { scope_type: 'building' },
      { severity: 'fatal' },
      { metric: 'pm_compliance_rate' },
      { notify_roles: ['org:org_administrator'] },
      { statement: '' },
    ]) {
      await expect(
        server.call('create_los_consequence', { ...base, ...patch })
      ).rejects.toBeInstanceOf(ZodError)
    }
  })

  it('sends the roles the app itself stores', async () => {
    const sent = captureBody('POST', '/v1/los-consequences')
    await server.call('create_los_consequence', {
      ...base,
      notify_roles: ['administrator', 'manager'],
    })
    expect(sent().notify_roles).toEqual(['administrator', 'manager'])
  })

  it('lets an update clear metric and scope_ref with null', async () => {
    const sent = captureBody('PATCH', `/v1/los-consequences/${ID}`)
    await server.call('update_los_consequence', {
      id: ID,
      scope_type: 'global',
      scope_ref: null,
      metric: null,
    })
    expect(sent()).toEqual({ scope_type: 'global', scope_ref: null, metric: null })
  })
})

describe('LoS engine - network criticality', () => {
  it('forwards criticality on create and rejects an unknown tier', async () => {
    const sent = captureBody('POST', '/v1/infrastructure-networks')
    await server.call('create_infrastructure_network', {
      name: 'Sidewalks',
      feature_class: 'sidewalk',
      criticality: 'high',
    })
    expect(sent().criticality).toBe('high')
    await expect(
      server.call('create_infrastructure_network', {
        name: 'Sidewalks',
        feature_class: 'sidewalk',
        criticality: 'urgent',
      })
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('lets an update clear criticality with null', async () => {
    const sent = captureBody('PATCH', `/v1/infrastructure-networks/${ID}`)
    await server.call('update_infrastructure_network', { id: ID, criticality: null })
    expect(sent()).toEqual({ criticality: null })
  })
})
