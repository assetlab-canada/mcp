// Linking forms to work orders and PM schedules.
//
// Two routes exist and the tools must keep them distinct:
//   - one specific record  → create_form_response (POST /v1/form-responses)
//   - every generated WO   → form_template_id on a PM schedule / PM template
//
// These tests pin the request shape each tool sends, since the gateway is what enforces
// the tenant, published-template and one-form-per-record rules.

import type { McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssetLabClient } from '../../src/client.js'
import { withToolAnnotations } from '../../src/tool-annotations.js'
import { registerTools } from '../../src/tools.js'
import { registerWriteTools } from '../../src/tools-write.js'
import { apiKey, single } from '../fixtures/factories.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'
import { asMcpServer, FakeMcpServer } from '../fixtures/tool-harness.js'

const TEMPLATE_ID = '550e8400-e29b-41d4-a716-446655440000'
const WORK_ORDER_ID = '550e8400-e29b-41d4-a716-446655440001'
const RESPONSE_ID = '550e8400-e29b-41d4-a716-446655440002'
const SITE_ID = '550e8400-e29b-41d4-a716-446655440003'

describe('Forms — attaching to a single record', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerTools(asMcpServer(server) as McpServer, client)
    registerWriteTools(withToolAnnotations(asMcpServer(server) as McpServer), client)
  })
  afterEach(() => fx.restore())

  it('create_form_response posts template_id + subject to /v1/form-responses', async () => {
    let body: Record<string, unknown> | undefined
    fx.on('POST', '/v1/form-responses', ({ body: b }) => {
      body = b as Record<string, unknown>
      return fx.json(single({ id: RESPONSE_ID, status: 'in_progress' }), 201)
    })

    const r = await server.call('create_form_response', {
      template_id: TEMPLATE_ID,
      subject_type: 'work_order',
      subject_id: WORK_ORDER_ID,
    })

    expect(body).toEqual({
      template_id: TEMPLATE_ID,
      subject_type: 'work_order',
      subject_id: WORK_ORDER_ID,
    })
    expect(JSON.parse(r.content[0].text).data.id).toBe(RESPONSE_ID)
  })

  it('create_form_response accepts every subject type the gateway supports', async () => {
    fx.on('POST', '/v1/form-responses', () => fx.json(single({ id: RESPONSE_ID }), 201))
    for (const subject_type of [
      'work_order',
      'pm_schedule',
      'infrastructure_asset',
      'compliance_record',
      'site',
    ]) {
      const r = await server.call('create_form_response', {
        template_id: TEMPLATE_ID,
        subject_type,
        subject_id: SITE_ID,
      })
      expect(r.isError).toBeFalsy()
    }
  })

  it('create_form_response rejects a subject_type outside that set before any HTTP call', async () => {
    let called = false
    fx.on('POST', '/v1/form-responses', () => {
      called = true
      return fx.json(single({ id: RESPONSE_ID }), 201)
    })
    await expect(
      server.call('create_form_response', {
        template_id: TEMPLATE_ID,
        subject_type: 'standalone',
        subject_id: WORK_ORDER_ID,
      })
    ).rejects.toThrow()
    expect(called).toBe(false)
  })

  it('create_form_response rejects a non-UUID template_id before any HTTP call', async () => {
    let called = false
    fx.on('POST', '/v1/form-responses', () => {
      called = true
      return fx.json(single({ id: RESPONSE_ID }), 201)
    })
    await expect(
      server.call('create_form_response', {
        template_id: 'the inspection form',
        subject_type: 'work_order',
        subject_id: WORK_ORDER_ID,
      })
    ).rejects.toThrow()
    expect(called).toBe(false)
  })

  it('create_form_response surfaces the gateway 409 when a form is already attached', async () => {
    fx.on('POST', '/v1/form-responses', () =>
      fx.json({ error: 'A form is already attached to this work_order' }, 409)
    )
    const r = await server.call('create_form_response', {
      template_id: TEMPLATE_ID,
      subject_type: 'work_order',
      subject_id: WORK_ORDER_ID,
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('already attached')
  })

  it('delete_form_response deletes by response id', async () => {
    let path: string | undefined
    fx.on('DELETE', /^\/v1\/form-responses\/[0-9a-f-]+$/, ({ url }) => {
      path = url.pathname
      return fx.json({ success: true, message: 'Deleted' })
    })
    await server.call('delete_form_response', { id: RESPONSE_ID })
    expect(path).toBe(`/v1/form-responses/${RESPONSE_ID}`)
  })

  it('bulk_create accepts form-responses so one form can be attached to many records', async () => {
    let items: unknown
    fx.on('POST', '/v1/form-responses/bulk', ({ body }) => {
      items = body
      return fx.json({ results: [], succeeded: 2, failed: 0 })
    })
    await server.call('bulk_create', {
      resource: 'form-responses',
      items: [
        { template_id: TEMPLATE_ID, subject_type: 'work_order', subject_id: WORK_ORDER_ID },
        { template_id: TEMPLATE_ID, subject_type: 'work_order', subject_id: SITE_ID },
      ],
    })
    expect(Array.isArray(items)).toBe(true)
    expect((items as unknown[]).length).toBe(2)
  })
})

describe('Forms — attaching to every work order a PM generates', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerWriteTools(withToolAnnotations(asMcpServer(server) as McpServer), client)
  })
  afterEach(() => fx.restore())

  it('create_pm_schedule forwards form_template_id', async () => {
    let body: Record<string, unknown> | undefined
    fx.on('POST', '/v1/pm-schedules', ({ body: b }) => {
      body = b as Record<string, unknown>
      return fx.json(single({ id: WORK_ORDER_ID }), 201)
    })
    await server.call('create_pm_schedule', {
      title: 'Monthly compressor inspection',
      form_template_id: TEMPLATE_ID,
    })
    expect(body?.form_template_id).toBe(TEMPLATE_ID)
  })

  it('update_pm_schedule forwards form_template_id and does not send it as an id', async () => {
    let body: Record<string, unknown> | undefined
    let path: string | undefined
    fx.on('PATCH', /^\/v1\/pm-schedules\/[0-9a-f-]+$/, ({ url, body: b }) => {
      path = url.pathname
      body = b as Record<string, unknown>
      return fx.json(single({ id: WORK_ORDER_ID }))
    })
    await server.call('update_pm_schedule', {
      id: WORK_ORDER_ID,
      form_template_id: TEMPLATE_ID,
    })
    expect(path).toBe(`/v1/pm-schedules/${WORK_ORDER_ID}`)
    expect(body?.form_template_id).toBe(TEMPLATE_ID)
    expect(body?.id).toBeUndefined()
  })

  it('create_pm_template forwards form_template_id', async () => {
    let body: Record<string, unknown> | undefined
    fx.on('POST', '/v1/pm-templates', ({ body: b }) => {
      body = b as Record<string, unknown>
      return fx.json(single({ id: WORK_ORDER_ID }), 201)
    })
    await server.call('create_pm_template', {
      title: 'Compressor PM',
      form_template_id: TEMPLATE_ID,
    })
    expect(body?.form_template_id).toBe(TEMPLATE_ID)
  })

  it('update_pm_template forwards form_template_id', async () => {
    let body: Record<string, unknown> | undefined
    fx.on('PATCH', /^\/v1\/pm-templates\/[0-9a-f-]+$/, ({ body: b }) => {
      body = b as Record<string, unknown>
      return fx.json(single({ id: WORK_ORDER_ID }))
    })
    await server.call('update_pm_template', {
      id: WORK_ORDER_ID,
      form_template_id: TEMPLATE_ID,
    })
    expect(body?.form_template_id).toBe(TEMPLATE_ID)
  })

  it('a PM schedule without a form omits form_template_id entirely', async () => {
    let body: Record<string, unknown> | undefined
    fx.on('POST', '/v1/pm-schedules', ({ body: b }) => {
      body = b as Record<string, unknown>
      return fx.json(single({ id: WORK_ORDER_ID }), 201)
    })
    await server.call('create_pm_schedule', { title: 'No form here' })
    expect(body && 'form_template_id' in body).toBe(false)
  })

  it('rejects a non-UUID form_template_id before any HTTP call', async () => {
    let called = false
    fx.on('POST', '/v1/pm-schedules', () => {
      called = true
      return fx.json(single({ id: WORK_ORDER_ID }), 201)
    })
    await expect(
      server.call('create_pm_schedule', {
        title: 'Bad link',
        form_template_id: 'monthly inspection',
      })
    ).rejects.toThrow()
    expect(called).toBe(false)
  })
})
