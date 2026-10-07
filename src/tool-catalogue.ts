/**
 * The tool and resource definitions, built once and registered on many servers.
 *
 * The Worker answers each request with a fresh McpServer. Building the 481 tool schemas
 * per request cost ~2x the CPU of SDK v1 and pushed requests past the Workers Free tier's
 * 10 ms limit (Error 1102, 3.0.0 rollback, PB-001 2026-10-07). Recording the registrations
 * once and replaying them makes a request's server cheap: registration is a map insert, and
 * each schema's JSON form is computed on first use and then shared.
 *
 * Handlers close over the AssetLabClient passed to buildToolCatalogue, so a catalogue shared
 * across requests needs a client whose API key resolves per request (see worker.ts).
 */
import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { registerApps } from './apps/index.js'
import type { AssetLabClient } from './client.js'
import { registerTools } from './tools.js'

type Registration = unknown[]

export type ToolCatalogue = {
  readonly tools: readonly Registration[]
  readonly resources: readonly Registration[]
}

type JsonSchema = Record<string, unknown>

const SDK_JSON_SCHEMA_TARGET = 'draft-2020-12'
type JsonSchemaOptions = Parameters<StandardSchemaWithJSON['~standard']['jsonSchema']['input']>[0]

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

// Frozen because one JSON object now serves every request: a mutation would leak across them.
function withMemoizedJsonSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const std = schema['~standard']
  const cache = new Map<string, JsonSchema>()
  const memoized =
    (io: 'input' | 'output') =>
    (options: JsonSchemaOptions): JsonSchema => {
      const key = `${io}:${options.target}`
      let json = cache.get(key)
      if (!json) {
        json = deepFreeze(std.jsonSchema[io](options) as JsonSchema)
        cache.set(key, json)
      }
      return json
    }
  const input = memoized('input')
  // The SDK converts with this target (JSON_SCHEMA_CONVERSION_TARGET, not exported). Computing it
  // now moves the cost to module load; if the SDK's target ever changes, this only fills lazily.
  input({ target: SDK_JSON_SCHEMA_TARGET })
  return { '~standard': { ...std, jsonSchema: { input, output: memoized('output') } } }
}

function isStandardSchema(value: unknown): value is StandardSchemaWithJSON {
  return typeof value === 'object' && value !== null && '~standard' in value
}

export function buildToolCatalogue(client: AssetLabClient): ToolCatalogue {
  const tools: Registration[] = []
  const resources: Registration[] = []
  const recorder = {
    registerTool: (...args: unknown[]) => {
      const [name, config, handler] = args as [string, Record<string, unknown>, unknown]
      const inputSchema = config.inputSchema
      tools.push([
        name,
        isStandardSchema(inputSchema)
          ? { ...config, inputSchema: withMemoizedJsonSchema(inputSchema) }
          : config,
        handler,
      ])
    },
    registerResource: (...args: unknown[]) => {
      resources.push(args)
    },
  }
  // The recorder implements only the two methods registration calls.
  const target = recorder as unknown as McpServer
  registerTools(target, client)
  registerApps(target, client)
  return { tools, resources }
}

/** Registers the catalogue on a server. Pass a withToolProfile view to register a subset. */
export function registerCatalogue(
  server: McpServer,
  catalogue: ToolCatalogue,
  options: { resources: boolean }
): void {
  const registerTool = server.registerTool.bind(server) as (...a: unknown[]) => unknown
  for (const registration of catalogue.tools) registerTool(...registration)
  if (!options.resources) return
  const registerResource = server.registerResource.bind(server) as (...a: unknown[]) => unknown
  for (const registration of catalogue.resources) registerResource(...registration)
}
