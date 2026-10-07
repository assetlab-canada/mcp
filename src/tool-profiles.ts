/**
 * Curated tool subsets for clients that cap how many tools one agent may host.
 *
 * The full catalog is 466 tools. Microsoft Copilot Studio's generative
 * orchestrator allows 128 per agent and Microsoft recommends 25-30, so the full
 * server either fails to attach or routes badly there. Claude and ChatGPT have
 * no such cap and keep using the unprofiled URL.
 *
 * Selected with `?profile=<name>` on the MCP endpoint. An unknown name is
 * rejected by the Worker rather than silently serving all 466.
 */
import type { McpServer } from '@modelcontextprotocol/server'

export const TOOL_PROFILES = {
  core: [
    // Where things are
    'list_sites',
    'get_site',
    'list_buildings',
    'list_locations',
    // What they are
    'list_assets',
    'get_asset',
    'list_asset_types',
    'list_asset_statuses',
    'list_systems',
    'list_system_classes',
    // Day-to-day work
    'list_work_orders',
    'get_work_order',
    'list_work_order_comments',
    'list_work_requests',
    'get_work_request',
    'list_pm_schedules',
    'get_pm_schedule',
    // Who and what it costs
    'list_vendors',
    'get_vendor',
    'list_users',
    'list_asset_costs',
    'get_dashboard_summary',
    // Writes - still gated by the API key's scopes
    'create_work_request',
    'create_work_order',
    'update_work_order',
    'create_work_order_comment',
    'create_asset',
    'update_asset',
  ],
} as const satisfies Record<string, readonly string[]>

export type ToolProfileName = keyof typeof TOOL_PROFILES

export function isToolProfile(name: string): name is ToolProfileName {
  return Object.hasOwn(TOOL_PROFILES, name)
}

/**
 * Instructions appended to SERVER_INSTRUCTIONS when a profile is active, so the
 * model knows the catalog is deliberately short and does not invent tool names.
 */
export const PROFILE_INSTRUCTIONS: Record<ToolProfileName, string> = {
  core: `

## This connection uses the "core" tool profile

You have a curated subset of AssetLab's tools: sites, buildings, locations, assets, work orders, work requests, PM schedules, vendors, users and costs. Projects, contracts, compliance, parts, invoices, purchase orders, forms, floorplans and infrastructure are NOT available here. If a request needs one of those, say so and tell the user to connect without the profile parameter for the full tool set. Never guess a tool name that is not in your list.`,
}

/**
 * Returns a view of the server whose `registerTool()` drops anything outside the
 * profile. Registration is the only thing this is used for; the caller keeps
 * the real server for `connect()`.
 */
export function withToolProfile(server: McpServer, profile: ToolProfileName): McpServer {
  const allowed = new Set<string>(TOOL_PROFILES[profile])
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(target, prop, receiver)
      const register = target.registerTool.bind(target) as (...a: unknown[]) => unknown
      return (...args: unknown[]) => (allowed.has(String(args[0])) ? register(...args) : undefined)
    },
  })
}
