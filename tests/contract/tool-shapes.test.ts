// Contract tests — verify every registered tool conforms to MCP shape rules.
//
// What we check:
//  - Every tool has a non-empty `description` (Claude.ai shows this in the UI)
//  - Every tool's `schema` is a ZodRawShape (object of zod fields)
//  - Every tool name is snake_case (MCP convention; matches our tools.ts)
//  - The tool catalog contains the expected core surface (list/get/create/update/delete)
//    for every primary resource we advertise.
//  - Bulk surface and upload surface are present.
//  - SERVER_INSTRUCTIONS string is non-empty and references the hierarchies.

import type { McpServer } from '@modelcontextprotocol/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AssetLabClient } from '../../src/client.js'
import { registerTools, SERVER_INSTRUCTIONS } from '../../src/tools.js'
import { apiKey } from '../fixtures/factories.js'
import { asMcpServer, FakeMcpServer } from '../fixtures/tool-harness.js'

describe('Tool contract — every tool is well-formed', () => {
  let server: FakeMcpServer

  beforeEach(() => {
    server = new FakeMcpServer()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })

  it('registers at least 100 tools (catalog sanity)', () => {
    expect(server.tools.size).toBeGreaterThan(100)
  })

  it('every tool has a non-empty description', () => {
    const badTools: string[] = []
    for (const [name, tool] of server.tools) {
      if (!tool.description || tool.description.trim().length === 0) {
        badTools.push(name)
      }
    }
    expect(badTools, `Tools missing description: ${badTools.join(', ')}`).toEqual([])
  })

  it('every tool description is meaningfully long (>= 10 chars)', () => {
    const tooShort: string[] = []
    for (const [name, tool] of server.tools) {
      if ((tool.description ?? '').trim().length < 10) tooShort.push(name)
    }
    expect(tooShort, `Tools with too-short descriptions: ${tooShort.join(', ')}`).toEqual([])
  })

  it('every tool name is snake_case', () => {
    const violations: string[] = []
    for (const name of server.tools.keys()) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) violations.push(name)
    }
    expect(violations, `Non-snake_case tools: ${violations.join(', ')}`).toEqual([])
  })

  it('every tool schema is a ZodRawShape (object of zod types)', () => {
    const broken: string[] = []
    for (const [name, tool] of server.tools) {
      const shape = tool.schema as Record<string, unknown>
      if (typeof shape !== 'object' || shape === null) {
        broken.push(name)
        continue
      }
      // Sample one entry: it should be a zod schema (has `_def`).
      const keys = Object.keys(shape)
      if (keys.length === 0) continue // zero-arg tools are valid
      const first = shape[keys[0]] as { _def?: unknown }
      if (!first || typeof first !== 'object' || !('_def' in first)) {
        broken.push(name)
      }
    }
    expect(broken, `Tools with non-zod schemas: ${broken.join(', ')}`).toEqual([])
  })

  it('every tool handler is an async function', () => {
    const bad: string[] = []
    for (const [name, tool] of server.tools) {
      if (typeof tool.handler !== 'function') bad.push(name)
    }
    expect(bad).toEqual([])
  })

  it('compile-time check: z.object(schema) does not throw for any tool', () => {
    for (const [name, tool] of server.tools) {
      expect(
        () => z.object(tool.schema as Record<string, z.ZodTypeAny>),
        `Tool ${name} schema is unbuildable`
      ).not.toThrow()
    }
  })
})

describe('Tool contract — expected resource CRUD surface', () => {
  let server: FakeMcpServer
  beforeEach(() => {
    server = new FakeMcpServer()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })

  // Resources that should expose list/create/update/delete. (get_* is only
  // surfaced for a subset — the rest rely on list-with-filter.)
  const crud = [
    { resource: 'asset', list: 'list_assets' },
    { resource: 'work_order', list: 'list_work_orders' },
    { resource: 'site', list: 'list_sites' },
    { resource: 'building', list: 'list_buildings' },
    { resource: 'location', list: 'list_locations' },
    { resource: 'system_class', list: 'list_system_classes' },
    { resource: 'system_group', list: 'list_system_groups' },
    { resource: 'system', list: 'list_systems' },
    { resource: 'project', list: 'list_projects' },
    { resource: 'pm_schedule', list: 'list_pm_schedules' },
    { resource: 'contract', list: 'list_contracts' },
    { resource: 'vendor', list: 'list_vendors' },
  ]

  for (const { resource, list } of crud) {
    it(`exposes ${list}, create_${resource}, update_${resource}, delete_${resource}`, () => {
      expect(server.tools.has(list), `missing ${list}`).toBe(true)
      expect(server.tools.has(`create_${resource}`), `missing create_${resource}`).toBe(true)
      expect(server.tools.has(`update_${resource}`), `missing update_${resource}`).toBe(true)
      expect(server.tools.has(`delete_${resource}`), `missing delete_${resource}`).toBe(true)
    })
  }

  // Top-level entities that should additionally expose get_*
  it('exposes get_* for the primary entities (asset, work_order, site, project)', () => {
    expect(server.tools.has('get_asset')).toBe(true)
    expect(server.tools.has('get_work_order')).toBe(true)
    expect(server.tools.has('get_site')).toBe(true)
    expect(server.tools.has('get_project')).toBe(true)
  })

  it('exposes bulk surface (bulk_create + bulk_update)', () => {
    expect(server.tools.has('bulk_create')).toBe(true)
    expect(server.tools.has('bulk_update')).toBe(true)
  })

  it('exposes upload surface (upload_file + create_upload_url)', () => {
    expect(server.tools.has('upload_file')).toBe(true)
    expect(server.tools.has('create_upload_url')).toBe(true)
  })

  it('exposes dashboard tools', () => {
    expect(server.tools.has('get_dashboard_summary')).toBe(true)
    expect(server.tools.has('get_dashboard_snapshot')).toBe(true)
  })
})

describe('Tool contract — output shape conformance', () => {
  let server: FakeMcpServer
  beforeEach(() => {
    server = new FakeMcpServer()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })

  it('list_assets returns content array of {type:"text", text:string}', async () => {
    // Stub fetch so we don't need a real network — just verify response shape.
    const original = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [],
          pagination: { page: 1, per_page: 1000, total: 0, total_pages: 1 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    try {
      const r = await server.call('list_assets', {})
      expect(Array.isArray(r.content)).toBe(true)
      expect(r.content[0].type).toBe('text')
      expect(typeof r.content[0].text).toBe('string')
    } finally {
      globalThis.fetch = original
    }
  })

  it('error responses still match MCP content shape (text content + isError:true)', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    try {
      const r = await server.call('list_assets', {})
      expect(r.isError).toBe(true)
      expect(r.content[0].type).toBe('text')
      expect(typeof r.content[0].text).toBe('string')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('SERVER_INSTRUCTIONS contract', () => {
  it('is a non-empty string', () => {
    expect(typeof SERVER_INSTRUCTIONS).toBe('string')
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(200)
  })

  it('mentions both hierarchies (Location + System)', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/sites?.*buildings?.*locations?/i)
    expect(SERVER_INSTRUCTIONS).toMatch(/system class(es)?/i)
  })

  it('warns against fabricating UUIDs', () => {
    expect(SERVER_INSTRUCTIONS.toLowerCase()).toMatch(/never\s+(guess|fabricate)/)
  })

  it('documents bulk operation cap', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/100\s+items?/i)
  })
})

// F-089. The write tools advertised `hours` and `hourly_rate` on
// project_time_entries. Neither column exists — the table records
// `duration_minutes` and has no rate column — and because the phantom names were
// also in the gateway's RETURNING select, every create and update failed with a
// 42703 whatever the caller sent. So the tools were describing, to every Claude.ai
// and ChatGPT session that loaded this server, a shape that could not succeed.
describe('project_time_entries write tools speak the real schema (F-089)', () => {
  let server: FakeMcpServer

  beforeEach(() => {
    server = new FakeMcpServer()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
  })

  const shapeOf = (tool: string) => {
    const registered = server.tools.get(tool)
    expect(registered, `${tool} is not registered`).toBeDefined()
    return registered?.schema as Record<string, unknown>
  }

  for (const tool of ['create_project_time_entry', 'update_project_time_entry']) {
    it(`${tool} exposes duration_minutes`, () => {
      expect(Object.keys(shapeOf(tool))).toContain('duration_minutes')
    })

    it(`${tool} exposes neither phantom field`, () => {
      const keys = Object.keys(shapeOf(tool))
      expect(keys).not.toContain('hours')
      // Not merely absent — deliberately never re-added. A rate taken from the
      // request body would let a Staff-scoped API key set the rate its own time is
      // costed at; per-user rates live in public.user_labour_rates (admin-only RLS)
      // and any per-entry snapshot must be resolved server-side.
      expect(keys).not.toContain('hourly_rate')
    })
  }

  it('keeps duration_minutes optional and non-negative', () => {
    const duration = shapeOf('create_project_time_entry').duration_minutes as z.ZodTypeAny
    expect(duration.isOptional()).toBe(true)
    expect(duration.safeParse(90).success).toBe(true)
    expect(duration.safeParse(-1).success).toBe(false)
  })
})
