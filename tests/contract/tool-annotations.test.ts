// Contract tests for tool titles and behaviour hints.
//
// Claude's connector directory flags every tool missing a title and a
// readOnlyHint or destructiveHint, and clients use the hints to decide which
// calls to confirm with the user. A read tool marked writable costs a needless
// prompt; a delete tool marked read-only skips one that matters.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import { AssetLabClient } from '../../src/client.js'
import { toolAnnotations, toolTitle } from '../../src/tool-annotations.js'
import { registerTools } from '../../src/tools.js'
import { apiKey } from '../fixtures/factories.js'
import { asMcpServer, FakeMcpServer } from '../fixtures/tool-harness.js'

function registerAll(): FakeMcpServer {
  const fake = new FakeMcpServer()
  registerTools(
    asMcpServer(fake) as McpServer,
    new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
  )
  return fake
}

const tools = [...registerAll().tools.values()]

describe('tool annotations', () => {
  it('registers every tool with a title and an explicit read-only or destructive hint', () => {
    const missing = tools
      .filter(
        t =>
          !t.annotations?.title ||
          typeof t.annotations.readOnlyHint !== 'boolean' ||
          typeof t.annotations.destructiveHint !== 'boolean'
      )
      .map(t => t.name)
    expect(tools.length).toBeGreaterThan(400)
    expect(missing).toEqual([])
  })

  it('marks list_ and get_ tools read-only and nothing else', () => {
    const wrong = tools
      .filter(t => t.annotations?.readOnlyHint !== /^(list|get)_/.test(t.name))
      .map(t => t.name)
    expect(wrong).toEqual([])
  })

  it('marks every delete_ and update_ tool destructive', () => {
    const wrong = tools
      .filter(t => /^(delete|update|bulk_update)/.test(t.name))
      .filter(t => t.annotations?.destructiveHint !== true)
      .map(t => t.name)
    expect(wrong).toEqual([])
  })

  it('does not mark create tools destructive', () => {
    const wrong = tools
      .filter(t => /^(create_|bulk_create|upload_)/.test(t.name))
      .filter(t => t.annotations?.destructiveHint !== false)
      .map(t => t.name)
    expect(wrong).toEqual([])
  })

  it('gives every tool a distinct title', () => {
    const titles = tools.map(t => t.annotations?.title)
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('writes titles in sentence case with acronyms kept', () => {
    expect(toolTitle('list_work_orders')).toBe('List work orders')
    expect(toolTitle('get_pm_schedule')).toBe('Get PM schedule')
    expect(toolTitle('list_site_fci_history')).toBe('List site FCI history')
    expect(toolTitle('create_los_measure')).toBe('Create LoS measure')
    expect(toolTitle('create_upload_url')).toBe('Create upload URL')
  })

  it('refuses a tool name with no annotation rule', () => {
    expect(() => toolAnnotations('archive_asset')).toThrow(/No annotation rule/)
  })
})
