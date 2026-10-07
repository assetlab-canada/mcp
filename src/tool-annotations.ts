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
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

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

/**
 * Returns a view of the server whose `tool(name, description, schema, handler)`
 * registers with a title and hints. Composes with `withToolProfile`.
 */
export function withToolAnnotations(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'tool') return Reflect.get(target, prop, receiver)
      return (...args: unknown[]) => {
        const [name, description, schema, handler] = args
        if (args.length !== 4 || typeof name !== 'string' || typeof handler !== 'function') {
          throw new Error(
            `Tool "${String(name)}" must be registered as tool(name, description, schema, handler).`
          )
        }
        const annotations = toolAnnotations(name)
        const register = target.tool.bind(target) as (...a: unknown[]) => unknown
        const registered = register(name, description, schema, annotations, handler)
        // The positional overload has no title slot; the spec's top-level title is what clients list.
        if (registered && typeof registered === 'object') {
          ;(registered as { title?: string }).title = annotations.title
        }
        return registered
      }
    },
  })
}
