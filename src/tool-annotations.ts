/**
 * Tool titles and behaviour hints, derived from the tool name.
 *
 * Claude's connector directory flags any tool without a `title` and a
 * `readOnlyHint` or `destructiveHint`, and clients use the hints to decide
 * which calls need the user's confirmation. Tool names here are regular
 * (`list_`/`get_`/`create_`/`update_`/`delete_` + resource), so the hints are
 * derived rather than written out on 480 registrations. A name outside the
 * known verbs throws at registration, so a new tool cannot ship unannotated.
 */
import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server'
import { type ZodRawShape, z } from 'zod'

// Keep zod 3's caller-facing wording: ids use guid() to accept what uuid() did, and a missing field says "Required".
z.config({
  customError: issue => {
    if (issue.code === 'invalid_format' && issue.format === 'guid') return 'Invalid UUID'
    if (issue.code === 'invalid_type' && issue.input === undefined) return 'Required'
    return undefined
  },
})

type Hints = Required<
  Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>
>

const READ: Hints = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const CREATE: Hints = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}
// An update overwrites values the user entered, which is a destructive update in MCP's terms.
const OVERWRITE: Hints = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
}

const HINTS_BY_VERB: Record<string, Hints> = {
  list: READ,
  get: READ,
  // show_* renders an MCP Apps view over a read.
  show: READ,
  create: CREATE,
  upload: CREATE,
  update: OVERWRITE,
  delete: OVERWRITE,
}

// bulk_create / bulk_update carry their verb second.
const HINTS_BY_NAME: Record<string, Hints> = {
  bulk_create: CREATE,
  bulk_update: OVERWRITE,
}

const ACRONYMS: Record<string, string> = {
  fci: 'FCI',
  los: 'LoS',
  pm: 'PM',
  url: 'URL',
}

export function toolTitle(name: string): string {
  const words = name.split('_').map(word => ACRONYMS[word] ?? word)
  const [first, ...rest] = words
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ')
}

export function toolAnnotations(name: string): ToolAnnotations & { title: string } {
  const hints = HINTS_BY_NAME[name] ?? HINTS_BY_VERB[name.split('_')[0]]
  if (!hints) {
    throw new Error(
      `No annotation rule for tool "${name}". Add its verb to HINTS_BY_VERB or the name to HINTS_BY_NAME in tool-annotations.ts.`
    )
  }
  return { title: toolTitle(name), ...hints }
}

/** The registration surface tools.ts and tools-write.ts are written against. */
export type ToolRegistrar = {
  tool<Shape extends ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>) => CallToolResult | Promise<CallToolResult>
  ): void
}

/**
 * Adapts the server to `tool(name, description, shape, handler)`, registering each
 * tool with its title and hints. SDK v2 removed that positional overload; keeping
 * it here leaves 466 call sites, and the guards that parse them, unchanged.
 * Composes with `withToolProfile`, which filters `registerTool` underneath.
 */
export function withToolAnnotations(server: McpServer): ToolRegistrar {
  return {
    tool(name, description, shape, handler) {
      const annotations = toolAnnotations(name)
      server.registerTool(
        name,
        { title: annotations.title, description, inputSchema: z.object(shape), annotations },
        handler
      )
    },
  }
}
