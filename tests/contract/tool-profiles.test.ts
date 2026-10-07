// Contract tests for the curated tool profiles (`?profile=core`).
//
// Microsoft Copilot Studio caps one agent at 128 tools and recommends 25-30.
// The full catalog is 466, so a profile is what makes that client usable at all.
// These tests pin the two ways a profile silently rots: a name that no longer
// exists after a rename, and a profile that drifts back over the cap.

import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { AssetLabClient } from '../../src/client.js'
import {
  isToolProfile,
  PROFILE_INSTRUCTIONS,
  TOOL_PROFILES,
  type ToolProfileName,
  withToolProfile,
} from '../../src/tool-profiles.js'
import { registerTools } from '../../src/tools.js'
import { apiKey } from '../fixtures/factories.js'
import { asMcpServer, FakeMcpServer } from '../fixtures/tool-harness.js'

// Copilot Studio's documented ceiling; Microsoft recommends 25-30 for routing quality.
const COPILOT_TOOL_CAP = 128
const COPILOT_RECOMMENDED_MAX = 30

function newClient(): AssetLabClient {
  return new AssetLabClient({ apiUrl: 'https://api.example.com', apiKey: apiKey() })
}

function registerAll(): FakeMcpServer {
  const fake = new FakeMcpServer()
  registerTools(asMcpServer(fake) as McpServer, newClient())
  return fake
}

function registerWithProfile(profile: ToolProfileName): FakeMcpServer {
  const fake = new FakeMcpServer()
  const profiled = withToolProfile(asMcpServer(fake) as McpServer, profile)
  registerTools(profiled, newClient())
  return fake
}

const profileNames = Object.keys(TOOL_PROFILES) as ToolProfileName[]

describe('tool profiles', () => {
  it.each(profileNames)('%s lists only tools that actually exist', profile => {
    const catalog = registerAll().tools
    const missing = TOOL_PROFILES[profile].filter(name => !catalog.has(name))
    expect(missing, `Profile "${profile}" names unknown tools: ${missing.join(', ')}`).toEqual([])
  })

  it.each(profileNames)('%s stays inside the Copilot Studio tool budget', profile => {
    const size = TOOL_PROFILES[profile].length
    expect(size).toBeLessThanOrEqual(COPILOT_TOOL_CAP)
    expect(size).toBeLessThanOrEqual(COPILOT_RECOMMENDED_MAX)
    expect(size).toBeGreaterThan(0)
  })

  it.each(profileNames)('%s has no duplicate entries', profile => {
    const names = TOOL_PROFILES[profile]
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(profileNames)('%s carries instructions naming what is missing', profile => {
    expect(PROFILE_INSTRUCTIONS[profile].length).toBeGreaterThan(100)
  })

  it('registers exactly the profile, not the full catalog', () => {
    const registered = [...registerWithProfile('core').tools.keys()].sort()
    expect(registered).toEqual([...TOOL_PROFILES.core].sort())
  })

  it('leaves the full catalog untouched when no profile is applied', () => {
    expect(registerAll().tools.size).toBeGreaterThan(COPILOT_TOOL_CAP)
  })

  it('keeps the filtered tools callable (schema and handler survive the proxy)', async () => {
    const fake = registerWithProfile('core')
    const listSites = fake.tools.get('list_sites')
    expect(listSites?.description.length).toBeGreaterThan(10)
    expect(typeof listSites?.handler).toBe('function')
  })

  it('recognizes known profiles and rejects unknown ones', () => {
    expect(isToolProfile('core')).toBe(true)
    expect(isToolProfile('CORE')).toBe(false)
    expect(isToolProfile('everything')).toBe(false)
    expect(isToolProfile('toString')).toBe(false)
  })
})
