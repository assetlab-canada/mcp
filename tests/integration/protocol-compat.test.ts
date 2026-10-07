// Protocol compatibility across MCP SDK generations, over the Worker's real HTTP handler.
//
// Claude.ai and ChatGPT do not upgrade when we do. The server moved to SDK v2 on 2026-10-07,
// serves the stateless 2026-07-28 protocol and, through createMcpHandler's fallback, the 2025
// eras. A client on the v1 SDK (what deployed clients run today), a default v2 client, and a v2
// client pinned to 2026-07-28 must each list tools, call one, and read the MCP Apps view.

import {
  Client as ClientV2,
  StreamableHTTPClientTransport as TransportV2,
} from '@modelcontextprotocol/client'
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SITE_FCI_TREND_URI } from '../../src/apps/index.js'
import worker from '../../src/worker.js'
import { paginated } from '../fixtures/factories.js'
import { type FetchFake, installFetchFake } from '../fixtures/fake-fetch.js'
import { FakeKV } from '../fixtures/fake-kv.js'
import { openLimiters } from '../fixtures/fake-rate-limiter.js'

type WorkerEnv = Parameters<typeof worker.fetch>[1]

const MCP_URL = new URL('https://mcp.assetlab.ca/mcp')
// Legacy API-key bearer: resolveAccessToken passes it through without KV.
const AUTH = { Authorization: 'Bearer al_test_protocolcompat000000000000' }

function env(): WorkerEnv {
  return {
    ASSETLAB_API_URL: 'https://api.example.com',
    OAUTH_SECRET: 'x'.repeat(48),
    OAUTH_CLIENTS: new FakeKV(),
    ...openLimiters(),
  } as unknown as WorkerEnv
}

function workerFetch(e: WorkerEnv) {
  return (input: string | URL | Request, init?: RequestInit) =>
    worker.fetch(new Request(input, init), e)
}

type Connected = {
  listTools(): Promise<{ tools: Array<{ name: string; _meta?: Record<string, unknown> }> }>
  callTool(p: { name: string; arguments: Record<string, unknown> }): Promise<unknown>
  readResource(p: { uri: string }): Promise<{ contents: Array<{ mimeType?: string }> }>
  close(): Promise<void>
}

async function connectV1(e: WorkerEnv): Promise<Connected> {
  const client = new ClientV1({ name: 'compat-v1', version: '0.0.0' })
  await client.connect(
    new TransportV1(MCP_URL, { fetch: workerFetch(e), requestInit: { headers: AUTH } })
  )
  return client as unknown as Connected
}

async function connectV2(e: WorkerEnv): Promise<Connected> {
  const client = new ClientV2({ name: 'compat-v2', version: '0.0.0' })
  await client.connect(
    new TransportV2(MCP_URL, { fetch: workerFetch(e), requestInit: { headers: AUTH } })
  )
  return client as unknown as Connected
}

// Pinned with no fallback: fails unless the Worker really serves the stateless protocol
// (server/discover, then per-request envelopes). The default v2 client negotiates 2025-11-25.
async function connectModern(e: WorkerEnv): Promise<Connected> {
  const client = new ClientV2(
    { name: 'compat-modern', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  )
  await client.connect(
    new TransportV2(MCP_URL, { fetch: workerFetch(e), requestInit: { headers: AUTH } })
  )
  return client as unknown as Connected
}

describe.each([
  ['v1 SDK client (deployed clients today)', connectV1],
  ['v2 SDK client on its default 2025-11-25 negotiation', connectV2],
  ['v2 SDK client pinned to the 2026-07-28 stateless protocol', connectModern],
])('MCP over HTTP with a %s', (_label, connect) => {
  let fx: FetchFake
  let client: Connected

  beforeEach(async () => {
    fx = installFetchFake()
    client = await connect(env())
  })
  afterEach(async () => {
    await client.close()
    fx.restore()
  })

  it('lists the full catalogue, including the MCP Apps tool and its _meta', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names.length).toBeGreaterThan(470)
    expect(names).toContain('list_assets')
    expect(names).toContain('bulk_create')
    expect(tools.find(t => t.name === 'show_site_fci_trend')?._meta).toMatchObject({
      ui: { resourceUri: SITE_FCI_TREND_URI },
    })
  })

  it('calls a tool through to the gateway and returns its data', async () => {
    fx.on('GET', '/v1/assets', () => fx.json(paginated([{ id: 'a1', name: 'Boiler 1' }])))
    const result = (await client.callTool({ name: 'list_assets', arguments: {} })) as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('Boiler 1')
  })

  it('rejects an invalid id with a message naming the field', async () => {
    const result = (await client.callTool({
      name: 'get_asset',
      arguments: { id: 'Boiler 1' },
    })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('id: Invalid UUID')
  })

  it('serves the MCP Apps view', async () => {
    const { contents } = await client.readResource({ uri: SITE_FCI_TREND_URI })
    expect(contents[0].mimeType).toBe('text/html;profile=mcp-app')
  })
})
