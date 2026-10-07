// F-266. update_work_order had no completion_notes field, so an assistant closing a work
// order could not record what was done, although the gateway accepts the column.

import type { McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssetLabClient } from '../../src/client.js'
import { withToolAnnotations } from '../../src/tool-annotations.js'
import { registerWriteTools } from '../../src/tools-write.js'
import { apiKey, single } from '../fixtures/factories.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'
import { asMcpServer, FakeMcpServer } from '../fixtures/tool-harness.js'

const ID = '11111111-1111-4111-8111-111111111111'

describe('update_work_order completion (F-266)', () => {
  let server: FakeMcpServer
  let fx: FetchFake

  beforeEach(() => {
    server = new FakeMcpServer()
    fx = installFetchFake()
    const client = new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
    registerWriteTools(withToolAnnotations(asMcpServer(server) as McpServer), client)
  })
  afterEach(() => fx.restore())

  it('forwards completion_notes with the status change', async () => {
    let body: unknown
    fx.on('PATCH', `/v1/work-orders/${ID}`, req => {
      body = req.body
      return fx.json(single({ id: ID, status: 'COMPLETED' }))
    })
    const r = await server.call('update_work_order', {
      id: ID,
      status: 'COMPLETED',
      completion_notes: 'Replaced the filter.',
    })
    expect(r.isError).toBeFalsy()
    expect(body).toMatchObject({ status: 'COMPLETED', completion_notes: 'Replaced the filter.' })
  })

  it('does not offer completed_at, which the database stamps', () => {
    expect(server.tools.get('update_work_order')?.schema).not.toHaveProperty('completed_at')
  })
})
