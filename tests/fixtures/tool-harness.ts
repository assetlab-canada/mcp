// Test harness that captures registered MCP tools.
//
// MCP SDK's McpServer.registerTool() registers handlers in private state. To exercise
// validation/dispatch logic without a real transport, we install a minimal
// fake server that records {name, description, schema, annotations, handler} into a Map.
// Tests then call handler({...args}) and inspect either zod validation errors
// (raised when args are invalid) or the dispatched HTTP behavior via fake-fetch.

import type { ToolAnnotations } from '@modelcontextprotocol/server'
import { type ZodRawShape, type ZodTypeAny, z } from 'zod'

export type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}>

export interface RegisteredTool {
  name: string
  description: string
  schema: ZodRawShape
  annotations?: ToolAnnotations
  handler: ToolHandler
}

export class FakeMcpServer {
  tools = new Map<string, RegisteredTool>()
  // The SDK v2 signature: registerTool(name, { title, description, inputSchema, annotations }, handler).
  // inputSchema is the z.object(...) withToolAnnotations builds; tests inspect its raw shape.
  registerTool(
    name: string,
    config: {
      description?: string
      inputSchema?: z.ZodObject<ZodRawShape>
      annotations?: ToolAnnotations
    },
    handler: ToolHandler
  ): void {
    this.tools.set(name, {
      name,
      description: config.description ?? '',
      schema: config.inputSchema?.shape ?? {},
      annotations: config.annotations,
      handler,
    })
  }

  /**
   * Validate args against the tool's zod schema, then dispatch. This mirrors
   * what the real MCP SDK does at the transport layer.
   */
  async call(
    name: string,
    args: Record<string, unknown>
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
  }> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    const schemaObj = z.object(tool.schema as Record<string, ZodTypeAny>)
    const parsed = schemaObj.safeParse(args)
    if (!parsed.success) {
      // Mirror MCP SDK behavior — schema mismatch is surfaced as a thrown
      // ZodError before the handler runs. Tests catch this.
      throw parsed.error
    }
    return tool.handler(parsed.data as Record<string, unknown>)
  }
}

/**
 * Type-cheat so we can pass FakeMcpServer where the real McpServer is expected.
 * The MCP SDK type surface is structural enough that registerTool() is all we need.
 */
export function asMcpServer(fake: FakeMcpServer): unknown {
  return fake
}
