/**
 * MCP write-tool registrations for AssetLab.
 *
 * Registers create, update, and delete tools for every API resource.
 * Each tool maps to POST / PATCH / DELETE on the AssetLab API Gateway.
 * Write tools require API keys with the appropriate :write scope.
 */

import { z } from 'zod'
import type { AssetLabClient } from './client.js'
import { formatError, formatResult } from './response-shaping.js'
import type { ToolRegistrar } from './tool-annotations.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip undefined values so the API only receives explicitly-set fields. */
function buildBody(params: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) body[k] = v
  }
  return body
}

const PM_RESOURCE_TYPES = ['TOOL', 'PART', 'MATERIAL', 'EQUIPMENT'] as const

const WORKSPACE = z.enum(['facilities', 'infrastructure', 'shared'])

// 'shared' is stored as null: the record is offered in both workspaces.
function workspaceBody(params: Record<string, unknown>): Record<string, unknown> {
  const body = buildBody(params)
  if (body.module === 'shared') body.module = null
  return body
}

// Shared by the four PM tools: linking a form here makes every work order the schedule
// generates carry a copy of that form for the technician to fill in.
const FORM_TEMPLATE_LINK_SCHEMA = z
  .string()
  .guid()
  .optional()
  .describe(
    'Form template ID to attach to every work order this generates - resolve via list_form_templates. Use a PUBLISHED template: generation resolves the current published version of the form, so a draft attaches nothing until it is published.'
  )

// Work orders and PM schedules store each association twice - a singular id and a plural array.
// The API mirrors whichever side is sent, but callers still need the arrays to associate several
// records at once (and systems, which have no singular field at all).
const ASSOCIATION_ARRAY_SCHEMA = (description: string) =>
  z.array(z.string().guid()).optional().describe(description)

const FORM_TEMPLATE_STATUSES = ['draft', 'published', 'archived'] as const
const FORM_ITEM_TYPES = [
  'section',
  'checkbox',
  'single_select',
  'multi_select',
  'number',
  'text',
  'photo',
] as const

function randomTaskId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  return g.crypto?.randomUUID?.() ?? `task_${Math.random().toString(36).slice(2, 12)}`
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * Shape pm_template tasks/resources to match the UI form's zod schema so
 * records written via MCP remain editable in the app. Unknown keys are dropped,
 * resource types are uppercased to the allowed enum, and task ids are filled in.
 */
function normalizePmTemplateBody(params: Record<string, unknown>): Record<string, unknown> {
  const out = { ...params }

  if (Array.isArray(out.tasks)) {
    out.tasks = out.tasks.map(raw => {
      const t = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const id = typeof t.id === 'string' && t.id.trim() !== '' ? t.id : randomTaskId()
      const description = typeof t.description === 'string' ? t.description : ''
      const completed = typeof t.completed === 'boolean' ? t.completed : false
      return { id, description, completed }
    })
  }

  if (Array.isArray(out.resources)) {
    out.resources = out.resources.map(raw => {
      const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const res: Record<string, unknown> = {}
      if (typeof r.name === 'string') res.name = r.name
      if (typeof r.type === 'string') {
        const upper = r.type.toUpperCase()
        if ((PM_RESOURCE_TYPES as readonly string[]).includes(upper)) res.type = upper
      }
      const cost = coerceNumber(r.cost)
      if (cost !== undefined) res.cost = cost
      const quantity = coerceNumber(r.quantity)
      if (quantity !== undefined) res.quantity = quantity
      return res
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWriteTools(server: ToolRegistrar, client: AssetLabClient): void {
  // ============================================================
  // 1. Work Orders (scope: work_orders)
  // ============================================================

  server.tool(
    'create_work_order',
    'Create a new work order. Requires work_orders:write scope. REQUIRED: title. STRONGLY RECOMMENDED: site_id, building_id and at least one target (asset_id, location_id, system_ids or infrastructure_asset_ids) - the AssetLab app always sets one, and a work order with no target is hard to find and to cost, so ask the user which applies before calling. The API accepts a work order without a target. Also recommended: work_category_id (look up via list_work_categories; omit only if no reasonable match exists). Location hierarchy: always resolve top-down by calling list_sites first, then list_buildings filtered by site_id, then list_locations filtered by building_id.',
    {
      title: z.string().min(1).max(500).describe('Work order title (required)'),
      description: z.string().optional().describe('Detailed description'),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional().describe('Priority level'),
      status: z
        .enum(['NEW', 'IN_PROGRESS', 'ON_HOLD', 'REJECTED', 'COMPLETED', 'CANCELLED'])
        .optional()
        .describe('Status'),
      type: z.enum(['PM', 'REACTIVE']).optional().describe('Work order type'),
      site_id: z.string().guid().optional().describe('Site ID - resolve first via list_sites'),
      building_id: z
        .string()
        .guid()
        .optional()
        .describe('Building ID - resolve second via list_buildings filtered by site_id'),
      location_id: z
        .string()
        .guid()
        .optional()
        .describe(
          'Location this work order is for - resolve last via list_locations filtered by building_id. The server mirrors it into location_ids, so send this OR location_ids, not a conflicting pair.'
        ),
      asset_id: z
        .string()
        .guid()
        .optional()
        .describe(
          'Asset this work order is for - resolve via list_assets. The server mirrors it into asset_ids.'
        ),
      location_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Locations this work order covers - use instead of location_id when there is more than one. Sending location_id alone replaces this with that single id.'
      ),
      asset_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Assets this work order covers - use instead of asset_id when there is more than one.'
      ),
      system_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Systems this work order covers - resolve via list_systems. Systems have no singular field; this array is the only way to associate them.'
      ),
      infrastructure_asset_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Infrastructure features this work order covers - resolve via list_infrastructure_assets. Use this when one job covers several features (a round of hydrant flushing); the whole selection is one work order with one completion and one cost, split across the features. Mutually exclusive with asset/location/system targets.'
      ),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      due_date: z.string().optional().describe('Due date (ISO 8601)'),
      estimated_time: z.number().min(0).optional().describe('Estimated time in hours'),
      estimated_cost: z.number().min(0).optional().describe('Estimated cost'),
      work_category_id: z.string().guid().optional().describe('Work category ID'),
      assigned_to: z.string().optional().describe('Assigned user ID (mapped to assignees array)'),
      assignees: z
        .array(z.string())
        .optional()
        .describe('Array of assigned user IDs (alternative to assigned_to for multiple assignees)'),
      image_url: z
        .string()
        .max(2000)
        .optional()
        .describe(
          'Image storage path (upload via create_upload_url with bucket "attachments", then set this to the returned path)'
        ),
      meter_reading: z
        .number()
        .min(0)
        .optional()
        .describe('Meter/odometer reading at time of service'),
      meter_unit: z.string().max(50).optional().describe('Meter unit (km, miles, hours, cycles)'),
      purchase_order_id: z
        .string()
        .guid()
        .optional()
        .describe(
          "Purchase order that paid this work order's actual cost - resolve via list_purchase_orders. Counts against the order's remaining balance."
        ),
    },
    async params => {
      try {
        const result = await client.create('work-orders', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_work_order',
    'Update an existing work order by ID. Requires work_orders:write scope. When changing location, resolve top-down: list_sites → list_buildings (by site_id) → list_locations (by building_id). Provide all three IDs. To complete a work order, set status COMPLETED and say what was done in completion_notes; completed_at is stamped automatically.',
    {
      id: z.string().guid().describe('Work order ID'),
      title: z.string().min(1).max(500).optional().describe('Work order title'),
      description: z.string().optional().describe('Detailed description'),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional().describe('Priority level'),
      status: z
        .enum(['NEW', 'IN_PROGRESS', 'ON_HOLD', 'REJECTED', 'COMPLETED', 'CANCELLED'])
        .optional()
        .describe('Status'),
      type: z.enum(['PM', 'REACTIVE']).optional().describe('Work order type'),
      site_id: z.string().guid().optional().describe('Site ID - resolve first via list_sites'),
      building_id: z
        .string()
        .guid()
        .optional()
        .describe('Building ID - resolve second via list_buildings filtered by site_id'),
      location_id: z
        .string()
        .guid()
        .optional()
        .describe(
          'Location this work order is for - resolve last via list_locations filtered by building_id. The server mirrors it into location_ids, so send this OR location_ids, not a conflicting pair.'
        ),
      asset_id: z
        .string()
        .guid()
        .optional()
        .describe(
          'Asset this work order is for - resolve via list_assets. The server mirrors it into asset_ids.'
        ),
      location_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Locations this work order covers - use instead of location_id when there is more than one. Sending location_id alone replaces this with that single id.'
      ),
      asset_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Assets this work order covers - use instead of asset_id when there is more than one.'
      ),
      system_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Systems this work order covers - resolve via list_systems. Systems have no singular field; this array is the only way to associate them.'
      ),
      infrastructure_asset_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Infrastructure features this work order covers - resolve via list_infrastructure_assets. Use this when one job covers several features (a round of hydrant flushing); the whole selection is one work order with one completion and one cost, split across the features. Mutually exclusive with asset/location/system targets.'
      ),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      due_date: z.string().optional().describe('Due date (ISO 8601)'),
      estimated_time: z.number().min(0).optional().describe('Estimated time in hours'),
      estimated_cost: z.number().min(0).optional().describe('Estimated cost'),
      work_category_id: z.string().guid().optional().describe('Work category ID'),
      assigned_to: z.string().optional().describe('Assigned user ID (mapped to assignees array)'),
      assignees: z
        .array(z.string())
        .optional()
        .describe('Array of assigned user IDs (alternative to assigned_to for multiple assignees)'),
      image_url: z
        .string()
        .max(2000)
        .optional()
        .describe(
          'Image storage path (upload via create_upload_url with bucket "attachments", then set this to the returned path)'
        ),
      meter_reading: z
        .number()
        .min(0)
        .optional()
        .describe('Meter/odometer reading at time of service'),
      meter_unit: z.string().max(50).optional().describe('Meter unit (km, miles, hours, cycles)'),
      purchase_order_id: z
        .string()
        .guid()
        .nullable()
        .optional()
        .describe(
          "Purchase order that paid this work order's actual cost - resolve via list_purchase_orders. Counts against the order's remaining balance; null clears it."
        ),
      completion_notes: z
        .string()
        .max(5000)
        .optional()
        .describe('What was done, recorded on the work order when it is completed'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('work-orders', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_work_order',
    'Delete a work order by ID. Requires work_orders:write scope.',
    { id: z.string().guid().describe('Work order ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('work-orders', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 2. Assets (scope: assets)
  // ============================================================

  server.tool(
    'create_asset',
    'Create a new asset. Requires assets:write scope. IMPORTANT - Location hierarchy: always resolve top-down by calling list_sites first, then list_buildings filtered by site_id, then list_locations filtered by building_id. Provide all three IDs (site_id, building_id, location_id) explicitly. System hierarchy: similarly resolve via list_system_classes → list_system_groups → list_systems.',
    {
      name: z.string().min(1).max(500).describe('Asset name (required)'),
      description: z.string().optional().describe('Description'),
      asset_id: z
        .string()
        .max(100)
        .optional()
        .describe('Custom asset identifier (unique per tenant)'),
      asset_type_id: z.string().guid().optional().describe('Asset type ID (from asset_types)'),
      manufacturer_id: z
        .string()
        .guid()
        .optional()
        .describe('Manufacturer ID (from manufacturers)'),
      model: z.string().max(500).optional().describe('Model name/number'),
      serial_number: z.string().max(200).optional().describe('Serial number'),
      purchase_cost: z.number().min(0).optional().describe('Purchase cost'),
      purchase_date: z.string().optional().describe('Purchase date (ISO 8601)'),
      replacement_value: z
        .number()
        .min(0)
        .optional()
        .describe(
          'Cost to replace this asset today, in current dollars. Distinct from purchase_cost, which is what was paid and is the depreciation basis.'
        ),
      replacement_value_reviewed_on: z
        .string()
        .optional()
        .describe('Date replacement_value was last confirmed (ISO 8601)'),
      expected_lifetime_years: z.number().min(0).optional().describe('Expected lifetime in years'),
      condition_score: z.number().min(0).max(100).optional().describe('Condition score (0-100)'),
      risk_factor: z
        .enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
        .optional()
        .describe('Risk factor (CRITICAL, HIGH, MEDIUM, LOW)'),
      status_id: z.string().max(100).optional().describe('Status identifier'),
      site_id: z.string().guid().optional().describe('Site ID - resolve first via list_sites'),
      building_id: z
        .string()
        .guid()
        .optional()
        .describe('Building ID - resolve second via list_buildings filtered by site_id'),
      location_id: z
        .string()
        .guid()
        .optional()
        .describe('Location ID - resolve last via list_locations filtered by building_id'),
      system_class_id: z
        .string()
        .guid()
        .optional()
        .describe('System class ID - resolve first via list_system_classes'),
      system_group_id: z
        .string()
        .guid()
        .optional()
        .describe(
          'System group ID - resolve second via list_system_groups filtered by system_class_id'
        ),
      system_id: z
        .string()
        .guid()
        .optional()
        .describe('System ID - resolve last via list_systems filtered by system_group_id'),
      image_url: z.string().max(2000).optional().describe('Image URL'),
      last_maintenance_date: z.string().optional().describe('Last maintenance date (ISO 8601)'),
      quantity: z.number().min(0).optional().describe('Quantity'),
      unit_of_measure: z.string().max(100).optional().describe('Unit of measure'),
      unit_replacement_value: z.number().min(0).optional().describe('Unit replacement value'),
      cost_per_sq_ft: z.number().min(0).optional().describe('Cost per square foot'),
      salvage_value: z.number().min(0).optional().describe('Salvage value'),
      salvage_value_percentage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Salvage value percentage (0-100)'),
      consequence_of_failure_score: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe(
          'Consequence of failure score, 1-5. Setting it makes it a manual value that a system change no longer replaces; send null to return it to the default from its system.'
        ),
      likelihood_of_failure_score: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe(
          'Likelihood of failure score, 1-5. Derived from condition_score unless set: setting it makes it a manual value that condition changes no longer replace; send null to return it to derivation.'
        ),
      safety_impact: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .optional()
        .describe('Safety impact level (LOW, MEDIUM, HIGH, CRITICAL)'),
      service_impact: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .optional()
        .describe('Service impact level (LOW, MEDIUM, HIGH, CRITICAL)'),
      environmental_impact: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .optional()
        .describe('Environmental impact level (LOW, MEDIUM, HIGH, CRITICAL)'),
      regulatory_impact: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .optional()
        .describe('Regulatory impact level (LOW, MEDIUM, HIGH, CRITICAL)'),
      reputation_impact: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .optional()
        .describe('Reputation impact level (LOW, MEDIUM, HIGH, CRITICAL)'),
      current_meter_reading: z
        .number()
        .min(0)
        .optional()
        .describe('Current meter/odometer reading'),
      meter_unit: z.string().max(50).optional().describe('Meter unit (km, miles, hours, cycles)'),
    },
    async params => {
      try {
        const result = await client.create('assets', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset',
    'Update an existing asset by ID. Requires assets:write scope. When changing location, resolve top-down: list_sites → list_buildings (by site_id) → list_locations (by building_id). Provide all three IDs. Same for systems: list_system_classes → list_system_groups → list_systems.',
    {
      id: z.string().guid().describe('Asset ID'),
      name: z.string().min(1).max(500).optional().describe('Asset name'),
      description: z.string().optional().describe('Description'),
      asset_id: z
        .string()
        .max(100)
        .optional()
        .describe('Custom asset identifier (unique per tenant)'),
      asset_type_id: z.string().guid().optional().describe('Asset type ID (from asset_types)'),
      manufacturer_id: z
        .string()
        .guid()
        .optional()
        .describe('Manufacturer ID (from manufacturers)'),
      model: z.string().max(500).optional().describe('Model name/number'),
      serial_number: z.string().max(200).optional().describe('Serial number'),
      purchase_cost: z.number().min(0).optional().describe('Purchase cost'),
      purchase_date: z.string().optional().describe('Purchase date (ISO 8601)'),
      replacement_value: z
        .number()
        .min(0)
        .optional()
        .describe(
          'Cost to replace this asset today, in current dollars. Distinct from purchase_cost, which is what was paid and is the depreciation basis.'
        ),
      replacement_value_reviewed_on: z
        .string()
        .optional()
        .describe('Date replacement_value was last confirmed (ISO 8601)'),
      expected_lifetime_years: z.number().min(0).optional().describe('Expected lifetime in years'),
      condition_score: z.number().min(0).max(100).optional().describe('Condition score (0-100)'),
      risk_factor: z
        .enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
        .optional()
        .describe('Risk factor (CRITICAL, HIGH, MEDIUM, LOW)'),
      status_id: z.string().max(100).optional().describe('Status identifier'),
      site_id: z.string().guid().optional().describe('Site ID - resolve first via list_sites'),
      building_id: z
        .string()
        .guid()
        .optional()
        .describe('Building ID - resolve second via list_buildings filtered by site_id'),
      location_id: z
        .string()
        .guid()
        .optional()
        .describe('Location ID - resolve last via list_locations filtered by building_id'),
      system_class_id: z
        .string()
        .guid()
        .optional()
        .describe('System class ID - resolve first via list_system_classes'),
      system_group_id: z
        .string()
        .guid()
        .optional()
        .describe(
          'System group ID - resolve second via list_system_groups filtered by system_class_id'
        ),
      system_id: z
        .string()
        .guid()
        .optional()
        .describe('System ID - resolve last via list_systems filtered by system_group_id'),
      image_url: z.string().max(2000).optional().describe('Image URL'),
      last_maintenance_date: z.string().optional().describe('Last maintenance date (ISO 8601)'),
      current_meter_reading: z
        .number()
        .min(0)
        .optional()
        .describe('Current meter/odometer reading'),
      meter_unit: z.string().max(50).optional().describe('Meter unit (km, miles, hours, cycles)'),
      quantity: z.number().min(0).optional().describe('Quantity'),
      unit_of_measure: z.string().max(100).optional().describe('Unit of measure'),
      unit_replacement_value: z.number().min(0).optional().describe('Unit replacement value'),
      cost_per_sq_ft: z.number().min(0).optional().describe('Cost per square foot'),
      salvage_value: z.number().min(0).optional().describe('Salvage value'),
      salvage_value_percentage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Salvage value percentage (0-100)'),
      consequence_of_failure_score: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe(
          'Consequence of failure score, 1-5. Setting it makes it a manual value that a system change no longer replaces; send null to return it to the default from its system.'
        ),
      likelihood_of_failure_score: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe(
          'Likelihood of failure score, 1-5. Derived from condition_score unless set: setting it makes it a manual value that condition changes no longer replace; send null to return it to derivation.'
        ),
      safety_impact: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .optional()
        .describe('Safety impact level (LOW, MEDIUM, HIGH, CRITICAL)'),
      service_impact: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .optional()
        .describe('Service impact level (LOW, MEDIUM, HIGH, CRITICAL)'),
      environmental_impact: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .optional()
        .describe('Environmental impact level (LOW, MEDIUM, HIGH, CRITICAL)'),
      regulatory_impact: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .optional()
        .describe('Regulatory impact level (LOW, MEDIUM, HIGH, CRITICAL)'),
      reputation_impact: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .optional()
        .describe('Reputation impact level (LOW, MEDIUM, HIGH, CRITICAL)'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('assets', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset',
    'Delete an asset by ID. Requires assets:write scope.',
    { id: z.string().guid().describe('Asset ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('assets', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 3. Work Requests (scope: work_requests)
  // ============================================================

  server.tool(
    'create_work_request',
    'Create a new work request. Requires work_requests:write scope. IMPORTANT - Location hierarchy: always resolve top-down by calling list_sites first, then list_buildings filtered by site_id, then list_locations filtered by building_id. Provide all three IDs (site_id, building_id, location_id) explicitly.',
    {
      title: z.string().min(1).max(500).describe('Work request title (required)'),
      description: z.string().optional().describe('Description'),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional().describe('Priority level'),
      status: z
        .enum(['PENDING_REVIEW'])
        .optional()
        .describe(
          'Omit it: new requests always start as PENDING_REVIEW. Approve or reject with update_work_request.'
        ),
      site_id: z.string().guid().optional().describe('Site ID - resolve first via list_sites'),
      building_id: z
        .string()
        .guid()
        .optional()
        .describe('Building ID - resolve second via list_buildings filtered by site_id'),
      location_id: z
        .string()
        .guid()
        .optional()
        .describe('Location ID - resolve last via list_locations filtered by building_id'),
      asset_id: z.string().guid().optional().describe('Asset ID'),
      system_id: z.string().guid().optional().describe('System ID'),
      work_category_id: z.string().guid().optional().describe('Work category ID'),
    },
    async params => {
      try {
        const result = await client.create('work-requests', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_work_request',
    'Update an existing work request by ID. Requires work_requests:write scope. Setting status to APPROVED creates a new work order from the request (its title, location and asset carry over) - confirm with the user first, and look the work order up afterwards with list_work_orders; REJECTED creates nothing. When changing location, resolve top-down: list_sites → list_buildings (by site_id) → list_locations (by building_id). Provide all three IDs.',
    {
      id: z.string().guid().describe('Work request ID'),
      title: z.string().min(1).max(500).optional().describe('Work request title'),
      description: z.string().optional().describe('Description'),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional().describe('Priority level'),
      status: z
        .enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED'])
        .optional()
        .describe('Status. New requests start as PENDING_REVIEW.'),
      site_id: z.string().guid().optional().describe('Site ID - resolve first via list_sites'),
      building_id: z
        .string()
        .guid()
        .optional()
        .describe('Building ID - resolve second via list_buildings filtered by site_id'),
      location_id: z
        .string()
        .guid()
        .optional()
        .describe('Location ID - resolve last via list_locations filtered by building_id'),
      asset_id: z.string().guid().optional().describe('Asset ID'),
      system_id: z.string().guid().optional().describe('System ID'),
      work_category_id: z.string().guid().optional().describe('Work category ID'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('work-requests', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_work_request',
    'Delete a work request by ID. Requires work_requests:write scope.',
    { id: z.string().guid().describe('Work request ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('work-requests', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 4. Vendors (scope: vendors)
  // ============================================================

  server.tool(
    'create_vendor',
    'Create a new vendor. Requires vendors:write scope.',
    {
      name: z.string().min(1).max(500).describe('Vendor name (required)'),
      contact_name: z.string().max(200).optional().describe('Contact person name'),
      contact_email: z.string().max(200).optional().describe('Contact email'),
      contact_phone: z.string().max(50).optional().describe('Contact phone'),
      address: z.string().max(500).optional().describe('Street address'),
      city: z.string().max(100).optional().describe('City'),
      state: z.string().max(100).optional().describe('State/province'),
      country: z.string().max(100).optional().describe('Country'),
      status: z.string().max(50).optional().describe('Vendor status'),
      categories: z
        .array(z.string().max(100))
        .optional()
        .describe('Vendor categories (e.g. ["HVAC", "Plumbing"])'),
      website: z
        .string()
        .max(500)
        .optional()
        .describe('Website URL (protocol and www prefix are stripped automatically)'),
      description: z.string().optional().describe('Description'),
    },
    async params => {
      try {
        const result = await client.create('vendors', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_vendor',
    'Update an existing vendor by ID. Requires vendors:write scope.',
    {
      id: z.string().guid().describe('Vendor ID'),
      name: z.string().min(1).max(500).optional().describe('Vendor name'),
      contact_name: z.string().max(200).optional().describe('Contact person name'),
      contact_email: z.string().max(200).optional().describe('Contact email'),
      contact_phone: z.string().max(50).optional().describe('Contact phone'),
      address: z.string().max(500).optional().describe('Street address'),
      city: z.string().max(100).optional().describe('City'),
      state: z.string().max(100).optional().describe('State/province'),
      country: z.string().max(100).optional().describe('Country'),
      status: z.string().max(50).optional().describe('Vendor status'),
      categories: z
        .array(z.string().max(100))
        .optional()
        .describe('Vendor categories (e.g. ["HVAC", "Plumbing"])'),
      website: z
        .string()
        .max(500)
        .optional()
        .describe('Website URL (protocol and www prefix are stripped automatically)'),
      description: z.string().optional().describe('Description'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('vendors', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_vendor',
    'Delete a vendor by ID. Requires vendors:write scope.',
    { id: z.string().guid().describe('Vendor ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('vendors', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 5. Sites (scope: sites)
  // ============================================================

  server.tool(
    'create_site',
    'Create a new site. Requires sites:write scope.',
    {
      name: z.string().min(1).max(500).describe('Site name (required)'),
      address: z.string().max(500).optional().describe('Street address'),
      city: z.string().max(200).optional().describe('City'),
      province: z.string().max(200).optional().describe('Province/state'),
      postal_code: z.string().max(20).optional().describe('Postal/zip code'),
      country: z.string().max(200).optional().describe('Country'),
      description: z.string().optional().describe('Description'),
      square_footage: z.number().min(0).optional().describe('Square footage'),
      cost_per_sqft: z.number().min(0).optional().describe('Base cost per square foot'),
      additional_cost_per_sqft: z
        .number()
        .min(0)
        .optional()
        .describe('Additional cost per square foot'),
      operational_cost_per_sqft: z
        .number()
        .min(0)
        .optional()
        .describe('Operational cost per square foot'),
      year_built: z.number().int().min(1800).max(2100).optional().describe('Year built'),
      contact_name: z.string().max(500).optional().describe('Primary contact name'),
      contact_email: z.string().max(500).optional().describe('Contact email'),
      contact_phone: z.string().max(50).optional().describe('Contact phone'),
      owner_landlord: z.string().max(500).optional().describe('Property owner or landlord'),
      ownership_type: z.enum(['Owned', 'Leased', 'Managed']).optional().describe('Ownership type'),
      lease_start_date: z.string().max(20).optional().describe('Lease start date (YYYY-MM-DD)'),
      lease_end_date: z.string().max(20).optional().describe('Lease end date (YYYY-MM-DD)'),
      renewal_option: z.string().max(500).optional().describe('Lease renewal option details'),
      lease_details: z.string().optional().describe('Free-text lease details / notes'),
      insurance_provider: z.string().max(500).optional().describe('Insurance provider name'),
      insurance_policy_number: z.string().max(200).optional().describe('Insurance policy number'),
      property_manager_company: z
        .string()
        .max(500)
        .optional()
        .describe('Property management company name'),
      property_manager_contact_name: z
        .string()
        .max(500)
        .optional()
        .describe('Property management contact name'),
      property_manager_contact_email: z
        .string()
        .max(500)
        .optional()
        .describe('Property management contact email'),
      property_manager_contact_phone: z
        .string()
        .max(50)
        .optional()
        .describe('Property management contact phone'),
    },
    async params => {
      try {
        const result = await client.create('sites', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_site',
    'Update an existing site by ID. Requires sites:write scope.',
    {
      id: z.string().guid().describe('Site ID'),
      name: z.string().min(1).max(500).optional().describe('Site name'),
      address: z.string().max(500).optional().describe('Street address'),
      city: z.string().max(200).optional().describe('City'),
      province: z.string().max(200).optional().describe('Province/state'),
      postal_code: z.string().max(20).optional().describe('Postal/zip code'),
      country: z.string().max(200).optional().describe('Country'),
      description: z.string().optional().describe('Description'),
      square_footage: z.number().min(0).optional().describe('Square footage'),
      cost_per_sqft: z.number().min(0).optional().describe('Base cost per square foot'),
      additional_cost_per_sqft: z
        .number()
        .min(0)
        .optional()
        .describe('Additional cost per square foot'),
      operational_cost_per_sqft: z
        .number()
        .min(0)
        .optional()
        .describe('Operational cost per square foot'),
      year_built: z.number().int().min(1800).max(2100).optional().describe('Year built'),
      contact_name: z.string().max(500).optional().describe('Primary contact name'),
      contact_email: z.string().max(500).optional().describe('Contact email'),
      contact_phone: z.string().max(50).optional().describe('Contact phone'),
      owner_landlord: z.string().max(500).optional().describe('Property owner or landlord'),
      ownership_type: z.enum(['Owned', 'Leased', 'Managed']).optional().describe('Ownership type'),
      lease_start_date: z.string().max(20).optional().describe('Lease start date (YYYY-MM-DD)'),
      lease_end_date: z.string().max(20).optional().describe('Lease end date (YYYY-MM-DD)'),
      renewal_option: z.string().max(500).optional().describe('Lease renewal option details'),
      lease_details: z.string().optional().describe('Free-text lease details / notes'),
      insurance_provider: z.string().max(500).optional().describe('Insurance provider name'),
      insurance_policy_number: z.string().max(200).optional().describe('Insurance policy number'),
      property_manager_company: z
        .string()
        .max(500)
        .optional()
        .describe('Property management company name'),
      property_manager_contact_name: z
        .string()
        .max(500)
        .optional()
        .describe('Property management contact name'),
      property_manager_contact_email: z
        .string()
        .max(500)
        .optional()
        .describe('Property management contact email'),
      property_manager_contact_phone: z
        .string()
        .max(50)
        .optional()
        .describe('Property management contact phone'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('sites', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_site',
    'Delete a site by ID. Requires sites:write scope.',
    { id: z.string().guid().describe('Site ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('sites', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 6. Buildings (scope: buildings)
  // ============================================================

  server.tool(
    'create_building',
    'Create a new building. Requires buildings:write scope. latitude and longitude place the building on the map and must be sent together - one without the other is rejected.',
    {
      name: z.string().min(1).max(500).describe('Building name (required)'),
      site_id: z.string().guid().describe('Site ID (required)'),
      floors: z.number().int().optional().describe('Number of floors'),
      area_sqft: z.number().min(0).optional().describe('Area in square feet'),
      type: z.string().max(100).optional().describe('Building type label'),
      building_type_id: z
        .string()
        .guid()
        .optional()
        .describe('Building type ID (from building_types)'),
      year_built: z
        .number()
        .int()
        .min(1800)
        .max(2100)
        .optional()
        .describe('Year the building was constructed'),
      latitude: z
        .number()
        .min(-90)
        .max(90)
        .optional()
        .describe(
          'WGS 84 latitude of the building, in decimal degrees. Must be sent together with longitude.'
        ),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .optional()
        .describe(
          'WGS 84 longitude of the building, in decimal degrees. Must be sent together with latitude.'
        ),
    },
    async params => {
      try {
        const result = await client.create('buildings', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_building',
    'Update an existing building by ID. Requires buildings:write scope. latitude and longitude must be sent together; send both as null to clear the building position.',
    {
      id: z.string().guid().describe('Building ID'),
      name: z.string().min(1).max(500).optional().describe('Building name'),
      site_id: z.string().guid().optional().describe('Site ID'),
      floors: z.number().int().optional().describe('Number of floors'),
      area_sqft: z.number().min(0).optional().describe('Area in square feet'),
      type: z.string().max(100).optional().describe('Building type label'),
      building_type_id: z
        .string()
        .guid()
        .optional()
        .describe('Building type ID (from building_types)'),
      year_built: z
        .number()
        .int()
        .min(1800)
        .max(2100)
        .optional()
        .describe('Year the building was constructed'),
      latitude: z
        .number()
        .min(-90)
        .max(90)
        .nullable()
        .optional()
        .describe(
          'WGS 84 latitude of the building, in decimal degrees. Must be sent together with longitude.'
        ),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .nullable()
        .optional()
        .describe(
          'WGS 84 longitude of the building, in decimal degrees. Must be sent together with latitude.'
        ),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('buildings', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_building',
    'Delete a building by ID. Requires buildings:write scope.',
    { id: z.string().guid().describe('Building ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('buildings', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 7. Locations (scope: locations)
  // ============================================================

  server.tool(
    'create_location',
    'Create a new location within a building. Requires locations:write scope.',
    {
      name: z.string().min(1).max(500).describe('Location name (required)'),
      building_id: z.string().guid().describe('Building ID (required)'),
      floor: z.string().max(50).optional().describe('Floor identifier'),
      area: z.number().min(0).optional().describe('Area (sq ft or sq m)'),
      type: z.string().max(100).optional().describe('Location type label'),
      location_type_id: z
        .string()
        .guid()
        .optional()
        .describe('Location type ID (from location_types)'),
    },
    async params => {
      try {
        const result = await client.create('locations', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_location',
    'Update an existing location by ID. Requires locations:write scope.',
    {
      id: z.string().guid().describe('Location ID'),
      name: z.string().min(1).max(500).optional().describe('Location name'),
      building_id: z.string().guid().optional().describe('Building ID'),
      floor: z.string().max(50).optional().describe('Floor identifier'),
      area: z.number().min(0).optional().describe('Area (sq ft or sq m)'),
      type: z.string().max(100).optional().describe('Location type label'),
      location_type_id: z
        .string()
        .guid()
        .optional()
        .describe('Location type ID (from location_types)'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('locations', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_location',
    'Delete a location by ID. Requires locations:write scope.',
    { id: z.string().guid().describe('Location ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('locations', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 8. PM Schedules (scope: pm_schedules)
  // ============================================================

  server.tool(
    'create_pm_schedule',
    'Create a new preventive maintenance schedule. Requires pm_schedules:write scope. IMPORTANT - Location hierarchy: always resolve top-down by calling list_sites first, then list_buildings filtered by site_id, then list_locations filtered by building_id. Provide all three IDs explicitly.',
    {
      title: z.string().min(1).max(500).describe('PM schedule title (required)'),
      description: z.string().optional().describe('Description'),
      frequency: z
        .enum([
          'DAILY',
          'WEEKLY',
          'MONTHLY',
          'QUARTERLY',
          'SEMI_ANNUAL',
          'ANNUAL',
          'FIVE_YEARLY',
          'CUSTOM',
        ])
        .optional()
        .describe('Frequency'),
      custom_interval_weeks: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Custom interval in weeks (when frequency is CUSTOM)'),
      next_due: z.string().optional().describe('Next due date (ISO 8601)'),
      estimated_hours: z.number().min(0).optional().describe('Estimated hours'),
      estimated_cost: z.number().min(0).optional().describe('Estimated cost'),
      site_id: z.string().guid().optional().describe('Site ID - resolve first via list_sites'),
      building_id: z
        .string()
        .guid()
        .optional()
        .describe('Building ID - resolve second via list_buildings filtered by site_id'),
      location_id: z
        .string()
        .guid()
        .optional()
        .describe('Location ID - resolve last via list_locations filtered by building_id'),
      asset_id: z.string().guid().optional().describe('Asset ID'),
      work_category: z.string().max(200).optional().describe('Work category label'),
      schedule_type: z.string().max(100).optional().describe('Schedule type'),
      lead_time_days: z.number().int().min(0).optional().describe('Lead time in days'),
      grace_period_days: z.number().int().min(0).optional().describe('Grace period in days'),
      safety_requirements: z.string().optional().describe('Safety requirements'),
      status: z.enum(['active', 'inactive']).optional().describe('Schedule status'),
      auto_generate_wo: z.boolean().optional().describe('Auto-generate work orders'),
      floating: z.boolean().optional().describe('Floating schedule (due date based on completion)'),
      meter_based: z
        .boolean()
        .optional()
        .describe('Whether this PM triggers at meter intervals (e.g. every 5000 km)'),
      meter_interval: z
        .number()
        .min(0)
        .optional()
        .describe('Meter interval - trigger every N units'),
      meter_unit: z.string().max(50).optional().describe('Meter unit (km, miles, hours, cycles)'),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      asset_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Assets this schedule covers - use instead of asset_id when there is more than one.'
      ),
      system_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Systems this schedule covers. Systems have no singular field; this array is the only way to associate them.'
      ),
      location_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Locations this schedule covers - use instead of location_id when there is more than one. Sending location_id alone replaces this with that single id.'
      ),
      infrastructure_asset_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Infrastructure features this schedule covers - resolve via list_infrastructure_assets. One schedule over several features generates one work order per cycle covering all of them. Mutually exclusive with asset/location/system targets.'
      ),
      tasks: z
        .array(
          z.object({
            id: z.string().describe('Unique task ID (use a random string)'),
            description: z.string().describe('Task description'),
            completed: z.boolean().describe('Whether the task is completed'),
          })
        )
        .optional()
        .describe('Checklist of tasks for this PM schedule'),
      form_template_id: FORM_TEMPLATE_LINK_SCHEMA,
    },
    async params => {
      try {
        const result = await client.create('pm-schedules', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_pm_schedule',
    'Update an existing PM schedule by ID. Requires pm_schedules:write scope. When changing location, resolve top-down: list_sites → list_buildings (by site_id) → list_locations (by building_id). Provide all three IDs.',
    {
      id: z.string().guid().describe('PM schedule ID'),
      title: z.string().min(1).max(500).optional().describe('PM schedule title'),
      description: z.string().optional().describe('Description'),
      frequency: z
        .enum([
          'DAILY',
          'WEEKLY',
          'MONTHLY',
          'QUARTERLY',
          'SEMI_ANNUAL',
          'ANNUAL',
          'FIVE_YEARLY',
          'CUSTOM',
        ])
        .optional()
        .describe('Frequency'),
      custom_interval_weeks: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Custom interval in weeks (when frequency is CUSTOM)'),
      next_due: z.string().optional().describe('Next due date (ISO 8601)'),
      estimated_hours: z.number().min(0).optional().describe('Estimated hours'),
      estimated_cost: z.number().min(0).optional().describe('Estimated cost'),
      site_id: z.string().guid().optional().describe('Site ID - resolve first via list_sites'),
      building_id: z
        .string()
        .guid()
        .optional()
        .describe('Building ID - resolve second via list_buildings filtered by site_id'),
      location_id: z
        .string()
        .guid()
        .optional()
        .describe('Location ID - resolve last via list_locations filtered by building_id'),
      asset_id: z.string().guid().optional().describe('Asset ID'),
      work_category: z.string().max(200).optional().describe('Work category label'),
      schedule_type: z.string().max(100).optional().describe('Schedule type'),
      lead_time_days: z.number().int().min(0).optional().describe('Lead time in days'),
      grace_period_days: z.number().int().min(0).optional().describe('Grace period in days'),
      safety_requirements: z.string().optional().describe('Safety requirements'),
      status: z.enum(['active', 'inactive']).optional().describe('Schedule status'),
      auto_generate_wo: z.boolean().optional().describe('Auto-generate work orders'),
      floating: z.boolean().optional().describe('Floating schedule (due date based on completion)'),
      meter_based: z.boolean().optional().describe('Whether this PM triggers at meter intervals'),
      meter_interval: z
        .number()
        .min(0)
        .optional()
        .describe('Meter interval - trigger every N units'),
      meter_unit: z.string().max(50).optional().describe('Meter unit (km, miles, hours, cycles)'),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      asset_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Assets this schedule covers - use instead of asset_id when there is more than one.'
      ),
      system_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Systems this schedule covers. Systems have no singular field; this array is the only way to associate them.'
      ),
      location_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Locations this schedule covers - use instead of location_id when there is more than one. Sending location_id alone replaces this with that single id.'
      ),
      infrastructure_asset_ids: ASSOCIATION_ARRAY_SCHEMA(
        'Infrastructure features this schedule covers - resolve via list_infrastructure_assets. One schedule over several features generates one work order per cycle covering all of them. Mutually exclusive with asset/location/system targets.'
      ),
      tasks: z
        .array(
          z.object({
            id: z.string().describe('Unique task ID'),
            description: z.string().describe('Task description'),
            completed: z.boolean().describe('Whether the task is completed'),
          })
        )
        .optional()
        .describe('Checklist of tasks for this PM schedule'),
      form_template_id: FORM_TEMPLATE_LINK_SCHEMA,
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('pm-schedules', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_pm_schedule',
    'Delete a PM schedule by ID. Requires pm_schedules:write scope.',
    { id: z.string().guid().describe('PM schedule ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('pm-schedules', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 8b. PM Templates (scope: pm_templates)
  // ============================================================

  server.tool(
    'create_pm_template',
    'Create a new PM template. Templates are reusable PM definitions (not linked to a site/asset) that can seed new PM schedules. Requires pm_templates:write scope.',
    {
      title: z.string().min(1).max(500).describe('PM template title (required, unique per tenant)'),
      description: z.string().optional().describe('Description'),
      frequency: z
        .enum([
          'DAILY',
          'WEEKLY',
          'MONTHLY',
          'QUARTERLY',
          'SEMI_ANNUAL',
          'ANNUAL',
          'FIVE_YEARLY',
          'CUSTOM',
        ])
        .optional()
        .describe('Suggested maintenance frequency'),
      custom_interval_weeks: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Custom interval in weeks (when frequency is CUSTOM)'),
      work_category: z.string().max(200).optional().describe('Work category label (free text)'),
      work_category_id: z
        .string()
        .guid()
        .optional()
        .describe('Work category ID - resolve via list_work_categories'),
      estimated_hours: z.number().min(0).optional().describe('Estimated hours'),
      estimated_cost: z.number().min(0).optional().describe('Estimated cost'),
      safety_requirements: z.string().optional().describe('Safety requirements'),
      tasks: z
        .array(
          z.object({
            id: z.string().optional().describe('Unique task ID (auto-generated if omitted)'),
            description: z.string().describe('Task description'),
            completed: z
              .boolean()
              .optional()
              .describe('Whether the task is completed (defaults to false)'),
          })
        )
        .optional()
        .describe('Checklist of tasks baked into this template'),
      resources: z
        .array(
          z.object({
            name: z.string().optional().describe('Resource name'),
            type: z
              .enum(PM_RESOURCE_TYPES)
              .optional()
              .describe('Resource type (TOOL, PART, MATERIAL, or EQUIPMENT)'),
            quantity: z.number().optional().describe('Quantity required'),
            cost: z.number().optional().describe('Unit cost'),
          })
        )
        .optional()
        .describe('Resource references (parts, tools, materials, equipment)'),
      documents: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe('Document references'),
      asset_ids: z
        .array(z.string().guid())
        .optional()
        .describe('Default asset IDs to seed on derived schedules'),
      location_ids: z
        .array(z.string().guid())
        .optional()
        .describe('Default location IDs to seed on derived schedules'),
      form_template_id: FORM_TEMPLATE_LINK_SCHEMA,
    },
    async params => {
      try {
        const result = await client.create(
          'pm-templates',
          buildBody(normalizePmTemplateBody(params))
        )
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_pm_template',
    'Update an existing PM template by ID. Requires pm_templates:write scope.',
    {
      id: z.string().guid().describe('PM template ID'),
      title: z.string().min(1).max(500).optional().describe('PM template title'),
      description: z.string().optional().describe('Description'),
      frequency: z
        .enum([
          'DAILY',
          'WEEKLY',
          'MONTHLY',
          'QUARTERLY',
          'SEMI_ANNUAL',
          'ANNUAL',
          'FIVE_YEARLY',
          'CUSTOM',
        ])
        .optional()
        .describe('Suggested maintenance frequency'),
      custom_interval_weeks: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Custom interval in weeks (when frequency is CUSTOM)'),
      work_category: z.string().max(200).optional().describe('Work category label (free text)'),
      work_category_id: z.string().guid().optional().describe('Work category ID'),
      estimated_hours: z.number().min(0).optional().describe('Estimated hours'),
      estimated_cost: z.number().min(0).optional().describe('Estimated cost'),
      safety_requirements: z.string().optional().describe('Safety requirements'),
      tasks: z
        .array(
          z.object({
            id: z.string().optional().describe('Unique task ID (auto-generated if omitted)'),
            description: z.string().describe('Task description'),
            completed: z
              .boolean()
              .optional()
              .describe('Whether the task is completed (defaults to false)'),
          })
        )
        .optional()
        .describe('Checklist of tasks baked into this template'),
      resources: z
        .array(
          z.object({
            name: z.string().optional().describe('Resource name'),
            type: z
              .enum(PM_RESOURCE_TYPES)
              .optional()
              .describe('Resource type (TOOL, PART, MATERIAL, or EQUIPMENT)'),
            quantity: z.number().optional().describe('Quantity required'),
            cost: z.number().optional().describe('Unit cost'),
          })
        )
        .optional()
        .describe('Resource references (parts, tools, materials, equipment)'),
      documents: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe('Document references'),
      asset_ids: z.array(z.string().guid()).optional().describe('Default asset IDs'),
      location_ids: z.array(z.string().guid()).optional().describe('Default location IDs'),
      form_template_id: FORM_TEMPLATE_LINK_SCHEMA,
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update(
          'pm-templates',
          id,
          buildBody(normalizePmTemplateBody(rest))
        )
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_pm_template',
    'Delete a PM template by ID. Requires pm_templates:write scope.',
    { id: z.string().guid().describe('PM template ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('pm-templates', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 8c. Forms & Inspections (scope: form_templates, form_template_items)
  // ============================================================

  server.tool(
    'create_form_template',
    'Create a form template - a reusable inspection, checklist, compliance, or survey definition. Step 1 of building a form: create it as a draft, then add questions with create_form_template_item (or bulk_create on form-template-items), then publish with update_form_template status=published (publishing is rejected if any question is malformed). Requires form_templates:write scope.',
    {
      name: z.string().min(1).max(500).describe('Form template name (required)'),
      description: z.string().max(5000).optional().describe('Description'),
      work_category_id: z
        .string()
        .guid()
        .optional()
        .describe(
          'Work category ID - the same tenant-configured categories used by work orders (e.g. Electrical, Plumbing, HVAC). Look them up with list_work_categories and pick the closest match; omit if none fits.'
        ),
      status: z
        .enum(FORM_TEMPLATE_STATUSES)
        .optional()
        .describe('Publication status - leave as draft (default) until all questions are added.'),
      module: WORKSPACE.optional().describe(
        'Workspace the form is offered in: facilities, infrastructure (inspections of features), or shared (both). Defaults to shared.'
      ),
    },
    async params => {
      try {
        const result = await client.create('form-templates', workspaceBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_form_template',
    'Update an existing form template by ID. Requires form_templates:write scope.',
    {
      id: z.string().guid().describe('Form template ID'),
      name: z.string().min(1).max(500).optional().describe('Form template name'),
      description: z.string().max(5000).optional().describe('Description'),
      work_category_id: z
        .string()
        .guid()
        .optional()
        .describe('Work category ID (look up with list_work_categories)'),
      status: z
        .enum(FORM_TEMPLATE_STATUSES)
        .optional()
        .describe('Publication status (draft, published, or archived)'),
      module: WORKSPACE.optional().describe(
        'Move the form to a workspace: facilities, infrastructure, or shared (both).'
      ),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('form-templates', id, workspaceBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_form_template',
    'Delete a form template by ID. Requires form_templates:write scope.',
    { id: z.string().guid().describe('Form template ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('form-templates', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'create_form_template_item',
    'Add one question (item) to a form template. Build a form by calling this once per question in order, or use bulk_create on form-template-items. Requires form_template_items:write scope.',
    {
      template_id: z.string().guid().describe('Form template ID - resolve via list_form_templates'),
      item_key: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Optional stable key, unique within the template. OMIT IT and the server derives one from the label (recommended). Only set it when a later item’s visible_when must reference this one - then use a short slug like "compressor_status".'
        ),
      sort_order: z
        .number()
        .int()
        .min(0)
        .describe('Display order within the template (0-based; questions render in this order)'),
      item_type: z
        .enum(FORM_ITEM_TYPES)
        .describe(
          'Pick by the answer you want: single_select = exactly one choice (Pass/Fail, Yes/No, Yes/No/N-A, or custom - supply options); multi_select = pick several (supply options); number = a numeric reading/count (use config.min/max/unit/integer); checkbox = a single done/not-done tick; text = free comment (config.multiline for long text); photo = photo evidence (config.maxPhotos); section = a non-answerable heading that groups the questions under it.'
        ),
      label: z.string().min(1).max(2000).describe('Question text / prompt shown to the user'),
      help_text: z.string().max(5000).optional().describe('Optional hint shown under the label'),
      required: z
        .boolean()
        .optional()
        .describe('Whether an answer is required to complete the form (default false)'),
      options: z
        .array(z.object({ value: z.string(), label: z.string() }))
        .optional()
        .describe(
          'REQUIRED for single_select/multi_select: at least 2 choices as { value, label } with unique values. value is a machine slug (e.g. "fail"), label is shown to the user (e.g. "Fail"). Omit for other types.'
        ),
      config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Per-type settings. number: { min, max, unit, integer, decimals }. text: { multiline, maxLength, placeholder }. multi_select: { minSelections, maxSelections }. photo: { minPhotos, maxPhotos }.'
        ),
      visible_when: z
        .object({ itemKey: z.string(), op: z.string(), value: z.unknown().optional() })
        .nullable()
        .optional()
        .describe(
          'Optional conditional visibility { itemKey, op, value }. itemKey must reference an EARLIER item’s key (set that item’s item_key explicitly). Operators by referenced type - single_select/checkbox: equals, not_equals, in, not_in, is_answered, is_blank; number: gt, lt, gte, lte, equals, not_equals, is_answered, is_blank; text: is_answered, is_blank, equals, not_equals; multi_select: in, not_in, is_answered, is_blank. e.g. show a "Details" text item only when item "compressor_status" equals "fail".'
        ),
    },
    async params => {
      try {
        const result = await client.create('form-template-items', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_form_template_item',
    'Update an existing form template item by ID. template_id and item_key are immutable and cannot be changed. Requires form_template_items:write scope.',
    {
      id: z.string().guid().describe('Form template item ID'),
      sort_order: z.number().int().min(0).optional().describe('Display order within the template'),
      item_type: z
        .enum(FORM_ITEM_TYPES)
        .optional()
        .describe(
          'Item type (section, checkbox, single_select, multi_select, number, text, photo)'
        ),
      label: z.string().min(1).max(2000).optional().describe('Question label / prompt'),
      help_text: z.string().max(5000).optional().describe('Help text shown under the label'),
      required: z.boolean().optional().describe('Whether an answer is required'),
      options: z
        .array(z.object({ value: z.string(), label: z.string() }))
        .optional()
        .describe('Choices for single_select / multi_select items'),
      config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Per-type configuration (e.g. { min, max, unit, multiline })'),
      visible_when: z
        .object({ itemKey: z.string(), op: z.string(), value: z.unknown().optional() })
        .nullable()
        .optional()
        .describe('Conditional-visibility rule referencing another item'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('form-template-items', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_form_template_item',
    'Delete a form template item by ID. Requires form_template_items:write scope.',
    { id: z.string().guid().describe('Form template item ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('form-template-items', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 8d. Form responses - attach / detach (scope: form_responses)
  // ============================================================

  server.tool(
    'create_form_response',
    "Attach a published form to one record so it can be filled in - the direct way to put an inspection or checklist on an existing work order. The form's questions are snapshotted at attach time, so later edits to the template never change a form already in progress. To put a form on every work order a PM schedule generates, set form_template_id on the schedule instead of calling this per work order. Answering and completing the form happen in the AssetLab app, not through this API. Requires form_responses:write scope.",
    {
      template_id: z
        .string()
        .guid()
        .describe(
          'Published form template ID - resolve via list_form_templates. A draft or archived template is rejected; publish it first with update_form_template status="published".'
        ),
      subject_type: z
        .enum(['work_order', 'pm_schedule', 'infrastructure_asset', 'compliance_record', 'site'])
        .describe('What kind of record the form is being attached to'),
      subject_id: z
        .string()
        .guid()
        .describe(
          'ID of the record - resolve via the matching list tool (list_work_orders, list_pm_schedules, list_infrastructure_assets, list_compliance_records, list_sites)'
        ),
    },
    async params => {
      try {
        const result = await client.create('form-responses', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_form_response',
    'Remove a form from the record it is attached to, along with any answers already given. Use this before attaching a different form, since a record holds at most one form. Requires form_responses:write scope.',
    {
      id: z
        .string()
        .guid()
        .describe('Form response ID - resolve via list_form_responses filtered by subject_id'),
    },
    async ({ id }) => {
      try {
        const result = await client.remove('form-responses', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 9. Projects (scope: projects)
  // ============================================================

  server.tool(
    'create_project',
    'Create a new project. Requires projects:write scope.',
    {
      name: z.string().min(1).max(500).describe('Project name (required)'),
      status: z.string().max(100).describe('Project status (required)'),
      start_date: z.string().describe('Start date (ISO 8601, required)'),
      project_code: z.string().max(100).optional().describe('Project code'),
      project_type: z
        .enum([
          'capital',
          'maintenance',
          'repair',
          'upgrade',
          'new_construction',
          'renovation',
          'deferred_maintenance',
          'other',
        ])
        .optional()
        .describe('Project type'),
      current_phase: z.string().max(100).optional().describe('Current phase'),
      description: z.string().optional().describe('Description'),
      end_date: z.string().optional().describe('End date (ISO 8601)'),
      budget: z.number().min(0).optional().describe('Total budget'),
      project_manager: z.string().max(200).optional().describe('Project manager name'),
      progress_percentage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Progress percentage (0-100)'),
      health_status: z
        .enum(['on_track', 'at_risk', 'delayed', 'critical'])
        .optional()
        .describe('Health status'),
      budget_status: z
        .enum(['off_track', 'on_track', 'not_set', 'monitor'])
        .optional()
        .describe('Budget status'),
      progress_status: z
        .enum(['off_track', 'on_track', 'monitor'])
        .optional()
        .describe('Progress status'),
      image_url: z.string().max(2000).optional().describe('Image URL'),
    },
    async params => {
      try {
        const result = await client.create('projects', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project',
    'Update an existing project by ID. Requires projects:write scope.',
    {
      id: z.string().guid().describe('Project ID'),
      name: z.string().min(1).max(500).optional().describe('Project name'),
      status: z.string().max(100).optional().describe('Project status'),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      project_code: z.string().max(100).optional().describe('Project code'),
      project_type: z
        .enum([
          'capital',
          'maintenance',
          'repair',
          'upgrade',
          'new_construction',
          'renovation',
          'deferred_maintenance',
          'other',
        ])
        .optional()
        .describe('Project type'),
      current_phase: z.string().max(100).optional().describe('Current phase'),
      description: z.string().optional().describe('Description'),
      end_date: z.string().optional().describe('End date (ISO 8601)'),
      budget: z.number().min(0).optional().describe('Total budget'),
      project_manager: z.string().max(200).optional().describe('Project manager name'),
      progress_percentage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Progress percentage (0-100)'),
      health_status: z
        .enum(['on_track', 'at_risk', 'delayed', 'critical'])
        .optional()
        .describe('Health status'),
      budget_status: z
        .enum(['off_track', 'on_track', 'not_set', 'monitor'])
        .optional()
        .describe('Budget status'),
      progress_status: z
        .enum(['off_track', 'on_track', 'monitor'])
        .optional()
        .describe('Progress status'),
      image_url: z.string().max(2000).optional().describe('Image URL'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('projects', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project',
    'Delete a project by ID. Requires projects:write scope.',
    { id: z.string().guid().describe('Project ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('projects', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 10. Contracts (scope: contracts)
  // ============================================================

  server.tool(
    'create_contract',
    'Create a new contract. Requires contracts:write scope.',
    {
      title: z.string().min(1).max(500).describe('Contract title (required)'),
      category: z.string().max(200).describe('Contract category (required)'),
      start_date: z.string().describe('Start date (ISO 8601, required)'),
      end_date: z.string().describe('End date (ISO 8601, required)'),
      company_id: z.string().guid().optional().describe('Vendor ID'),
      purchase_order: z.string().max(200).optional().describe('Purchase order reference'),
      extendable: z.boolean().optional().describe('Whether contract is extendable'),
      annual_cost: z.number().min(0).optional().describe('Annual cost'),
      description: z.string().optional().describe('Description'),
      quality_score: z.number().min(1).max(10).optional().describe('Quality score (1-10)'),
    },
    async params => {
      try {
        const result = await client.create('contracts', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_contract',
    'Update an existing contract by ID. Requires contracts:write scope.',
    {
      id: z.string().guid().describe('Contract ID'),
      title: z.string().min(1).max(500).optional().describe('Contract title'),
      category: z.string().max(200).optional().describe('Contract category'),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      end_date: z.string().optional().describe('End date (ISO 8601)'),
      company_id: z.string().guid().optional().describe('Vendor ID'),
      purchase_order: z.string().max(200).optional().describe('Purchase order reference'),
      extendable: z.boolean().optional().describe('Whether contract is extendable'),
      annual_cost: z.number().min(0).optional().describe('Annual cost'),
      description: z.string().optional().describe('Description'),
      quality_score: z.number().min(1).max(10).optional().describe('Quality score (1-10)'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('contracts', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_contract',
    'Delete a contract by ID. Requires contracts:write scope.',
    { id: z.string().guid().describe('Contract ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('contracts', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 11. Invoices (scope: invoices)
  // ============================================================

  server.tool(
    'create_invoice',
    'Create a new invoice. Requires invoices:write scope.',
    {
      invoice_number: z.string().min(1).max(200).describe('Invoice number (required)'),
      amount: z.number().min(0).describe('Invoice amount (required)'),
      invoice_date: z.string().describe('Invoice date (ISO 8601, required)'),
      description: z.string().optional().describe('Description'),
      tax_amount: z.number().min(0).optional().describe('Tax amount'),
      due_date: z.string().optional().describe('Due date (ISO 8601)'),
      paid_date: z.string().optional().describe('Paid date (ISO 8601)'),
      status: z
        .enum(['pending', 'approved', 'paid', 'voided'])
        .optional()
        .describe('Invoice status'),
      notes: z.string().optional().describe('Notes'),
      project_id: z.string().guid().optional().describe('Project ID'),
      work_order_id: z.string().guid().optional().describe('Work order ID'),
      purchase_order_id: z.string().guid().optional().describe('Purchase order ID'),
      vendor_id: z.string().guid().optional().describe('Vendor ID'),
      category_id: z.string().guid().optional().describe('Cost category ID'),
    },
    async params => {
      try {
        const result = await client.create('invoices', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_invoice',
    'Update an existing invoice by ID. Requires invoices:write scope.',
    {
      id: z.string().guid().describe('Invoice ID'),
      invoice_number: z.string().min(1).max(200).optional().describe('Invoice number'),
      amount: z.number().min(0).optional().describe('Invoice amount'),
      invoice_date: z.string().optional().describe('Invoice date (ISO 8601)'),
      description: z.string().optional().describe('Description'),
      tax_amount: z.number().min(0).optional().describe('Tax amount'),
      due_date: z.string().optional().describe('Due date (ISO 8601)'),
      paid_date: z.string().optional().describe('Paid date (ISO 8601)'),
      status: z
        .enum(['pending', 'approved', 'paid', 'voided'])
        .optional()
        .describe('Invoice status'),
      notes: z.string().optional().describe('Notes'),
      project_id: z.string().guid().optional().describe('Project ID'),
      work_order_id: z.string().guid().optional().describe('Work order ID'),
      purchase_order_id: z.string().guid().optional().describe('Purchase order ID'),
      vendor_id: z.string().guid().optional().describe('Vendor ID'),
      category_id: z.string().guid().optional().describe('Cost category ID'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('invoices', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_invoice',
    'Delete an invoice by ID. Requires invoices:write scope.',
    { id: z.string().guid().describe('Invoice ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('invoices', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 12. Purchase Orders (scope: purchase_orders)
  // ============================================================

  server.tool(
    'create_purchase_order',
    'Create a new purchase order. Requires purchase_orders:write scope.',
    {
      po_number: z.string().min(1).max(200).describe('PO number (required)'),
      amount: z.number().min(0).describe('PO amount (required)'),
      description: z.string().optional().describe('Description'),
      status: z
        .enum(['draft', 'issued', 'partially_received', 'received', 'closed', 'cancelled'])
        .optional()
        .describe('PO status'),
      issued_date: z.string().optional().describe('Issued date (ISO 8601)'),
      expected_date: z.string().optional().describe('Expected delivery date (ISO 8601)'),
      notes: z.string().optional().describe('Notes'),
      project_id: z.string().guid().optional().describe('Project ID'),
      work_order_id: z.string().guid().optional().describe('Work order ID'),
      vendor_id: z.string().guid().optional().describe('Vendor ID'),
      category_id: z.string().guid().optional().describe('Cost category ID'),
    },
    async params => {
      try {
        const result = await client.create('purchase-orders', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_purchase_order',
    'Update an existing purchase order by ID. Requires purchase_orders:write scope.',
    {
      id: z.string().guid().describe('Purchase order ID'),
      po_number: z.string().min(1).max(200).optional().describe('PO number'),
      amount: z.number().min(0).optional().describe('PO amount'),
      description: z.string().optional().describe('Description'),
      status: z
        .enum(['draft', 'issued', 'partially_received', 'received', 'closed', 'cancelled'])
        .optional()
        .describe('PO status'),
      issued_date: z.string().optional().describe('Issued date (ISO 8601)'),
      expected_date: z.string().optional().describe('Expected delivery date (ISO 8601)'),
      notes: z.string().optional().describe('Notes'),
      project_id: z.string().guid().optional().describe('Project ID'),
      work_order_id: z.string().guid().optional().describe('Work order ID'),
      vendor_id: z.string().guid().optional().describe('Vendor ID'),
      category_id: z.string().guid().optional().describe('Cost category ID'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('purchase-orders', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'create_purchase_order_line',
    "Add a line item to a purchase order. Requires purchase_orders:write scope. The PO's amount becomes the sum of its lines. A line naming a part_id is counted in whole units, and its quantity_received is added to that part's stock. Required: purchase_order_id, description, quantity.",
    {
      purchase_order_id: z
        .string()
        .guid()
        .describe('Purchase order ID (required) - resolve via list_purchase_orders'),
      description: z.string().min(1).max(2000).describe('What is being ordered (required)'),
      quantity: z.number().positive().describe('Quantity ordered (required)'),
      unit_cost: z
        .number()
        .min(0)
        .optional()
        .describe('Price per unit, in the organization currency'),
      quantity_received: z
        .number()
        .min(0)
        .optional()
        .describe('Quantity received so far, 0 to quantity'),
      part_id: z
        .string()
        .guid()
        .optional()
        .describe('Part from inventory - resolve via list_parts'),
      line_number: z.number().int().min(1).optional().describe('Position on the order'),
    },
    async params => {
      try {
        const result = await client.create('purchase-order-lines', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_purchase_order_line',
    "Update a purchase order line item. Requires purchase_orders:write scope. To receive goods, set quantity_received; for a line with a part, the change is added to (or taken from) that part's stock. A line with stock received cannot change its part.",
    {
      id: z.string().guid().describe('Purchase order line ID'),
      description: z.string().min(1).max(2000).optional().describe('What is being ordered'),
      quantity: z.number().positive().optional().describe('Quantity ordered'),
      unit_cost: z
        .number()
        .min(0)
        .optional()
        .describe('Price per unit, in the organization currency'),
      quantity_received: z
        .number()
        .min(0)
        .optional()
        .describe('Quantity received so far, 0 to quantity'),
      part_id: z.string().guid().optional().describe('Part from inventory'),
      line_number: z.number().int().min(1).optional().describe('Position on the order'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('purchase-order-lines', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_purchase_order_line',
    'Delete a purchase order line item. Requires purchase_orders:write scope. A line with stock received is refused until its quantity_received is set back to 0.',
    { id: z.string().guid().describe('Purchase order line ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('purchase-order-lines', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'create_purchase_order_link',
    'Link a purchase order to a work order, PM schedule or project for reference. Requires purchase_orders:write scope. Required: purchase_order_id and exactly one of work_order_id, pm_schedule_id, project_id. A link does not add to committed cost; to charge the cost, set project_id or work_order_id on the purchase order itself.',
    {
      purchase_order_id: z.string().guid().describe('Purchase order ID (required)'),
      work_order_id: z
        .string()
        .guid()
        .optional()
        .describe('Work order to link - resolve via list_work_orders'),
      pm_schedule_id: z
        .string()
        .guid()
        .optional()
        .describe('PM schedule to link - resolve via list_pm_schedules'),
      project_id: z
        .string()
        .guid()
        .optional()
        .describe('Project to link - resolve via list_projects'),
    },
    async params => {
      try {
        const result = await client.create('purchase-order-links', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_purchase_order_link',
    'Remove a purchase order link. Requires purchase_orders:write scope.',
    { id: z.string().guid().describe('Purchase order link ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('purchase-order-links', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_purchase_order',
    'Delete a purchase order by ID. Requires purchase_orders:write scope.',
    { id: z.string().guid().describe('Purchase order ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('purchase-orders', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 13. Expenses (scope: expenses)
  // ============================================================

  server.tool(
    'create_expense',
    'Create a new expense. Requires expenses:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      description: z.string().min(1).describe('Expense description (required)'),
      amount: z.number().min(0).describe('Expense amount (required)'),
      expense_date: z.string().describe('Expense date (ISO 8601, required)'),
      work_order_id: z.string().guid().optional().describe('Work order ID'),
      category_id: z.string().guid().optional().describe('Cost category ID'),
      receipt_url: z.string().max(2000).optional().describe('Receipt URL'),
      notes: z.string().optional().describe('Notes'),
    },
    async params => {
      try {
        const result = await client.create('expenses', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_expense',
    'Update an existing expense by ID. Requires expenses:write scope.',
    {
      id: z.string().guid().describe('Expense ID'),
      project_id: z.string().guid().optional().describe('Project ID'),
      description: z.string().optional().describe('Expense description'),
      amount: z.number().min(0).optional().describe('Expense amount'),
      expense_date: z.string().optional().describe('Expense date (ISO 8601)'),
      work_order_id: z.string().guid().optional().describe('Work order ID'),
      category_id: z.string().guid().optional().describe('Cost category ID'),
      receipt_url: z.string().max(2000).optional().describe('Receipt URL'),
      notes: z.string().optional().describe('Notes'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('expenses', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_expense',
    'Delete an expense by ID. Requires expenses:write scope.',
    { id: z.string().guid().describe('Expense ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('expenses', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Change Orders (scope: change_orders)
  // ============================================================

  server.tool(
    'create_change_order',
    'Create a new change order. Requires change_orders:write scope.',
    {
      co_number: z.string().min(1).max(200).describe('Change order number (required)'),
      description: z.string().min(1).describe('Description (required)'),
      amount: z.number().describe('Amount (required, negative for credits)'),
      status: z.enum(['draft', 'submitted', 'approved', 'rejected']).optional().describe('Status'),
      reason: z.string().optional().describe('Reason for the change order'),
      notes: z.string().optional().describe('Additional notes'),
      project_id: z.string().guid().optional().describe('Project ID'),
      vendor_id: z.string().guid().optional().describe('Vendor ID'),
      category_id: z.string().guid().optional().describe('Cost category ID'),
    },
    async params => {
      try {
        const result = await client.create('change-orders', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_change_order',
    'Update an existing change order by ID. Requires change_orders:write scope.',
    {
      id: z.string().guid().describe('Change order ID'),
      co_number: z.string().min(1).max(200).optional().describe('Change order number'),
      description: z.string().optional().describe('Description'),
      amount: z.number().optional().describe('Amount (negative for credits)'),
      status: z.enum(['draft', 'submitted', 'approved', 'rejected']).optional().describe('Status'),
      reason: z.string().optional().describe('Reason'),
      notes: z.string().optional().describe('Notes'),
      project_id: z.string().guid().optional().describe('Project ID'),
      vendor_id: z.string().guid().optional().describe('Vendor ID'),
      category_id: z.string().guid().optional().describe('Cost category ID'),
      approved_by: z.string().optional().describe('Approved by (user ID)'),
      approved_at: z.string().optional().describe('Approval date (ISO 8601)'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('change-orders', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_change_order',
    'Delete a change order by ID. Requires change_orders:write scope.',
    { id: z.string().guid().describe('Change order ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('change-orders', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Document Folder Templates (scope: project_document_folder_templates)
  // ============================================================

  server.tool(
    'create_project_document_folder_template',
    'Create a project document folder template. Requires project_document_folder_templates:write scope.',
    {
      name: z.string().min(1).max(500).describe('Template name (required)'),
      description: z.string().max(2000).optional().describe('Template description'),
      structure: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe('Folder hierarchy as JSON array'),
      is_default: z.boolean().optional().describe('Whether this is the default template'),
    },
    async params => {
      try {
        const result = await client.create('project-document-folder-templates', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_document_folder_template',
    'Update a project document folder template by ID. Requires project_document_folder_templates:write scope.',
    {
      id: z.string().guid().describe('Template ID'),
      name: z.string().min(1).max(500).optional().describe('Template name'),
      description: z.string().max(2000).optional().describe('Template description'),
      structure: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe('Folder hierarchy as JSON array'),
      is_default: z.boolean().optional().describe('Whether this is the default template'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-document-folder-templates', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_document_folder_template',
    'Delete a project document folder template by ID. Requires project_document_folder_templates:write scope.',
    { id: z.string().guid().describe('Template ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-document-folder-templates', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 14. Budgets (scope: budgets)
  // ============================================================

  server.tool(
    'create_budget',
    "Set an annual funding budget, as the dashboard Budget tab does. Requires budgets:write scope. The tab holds one figure per year, per funding source ('O&M' or 'Capital'), per workspace (module: facilities, infrastructure, or omitted for organization-wide). Send one row per year and funding source - do not split a year across sites or buildings; the tab does not read site_id or building_id and a second row for the same slot is refused with 409. Required: year, funding_source, budgeted_amount.",
    {
      year: z.number().int().min(2000).max(2100).describe('Budget year (required)'),
      funding_source: z
        .enum(['O&M', 'Capital'])
        .describe("'O&M' (operations and maintenance) or 'Capital' (required)"),
      module: z
        .enum(['facilities', 'infrastructure'])
        .optional()
        .describe(
          'Workspace the budget belongs to. Omit for an organization-wide budget; set it when the organization budgets facilities and infrastructure separately.'
        ),
      site_id: z.string().guid().optional().describe('Site ID. Not read by the Budget tab.'),
      building_id: z
        .string()
        .guid()
        .optional()
        .describe('Building ID. Not read by the Budget tab.'),
      budgeted_amount: z.number().min(0).optional().describe('Budgeted amount'),
      allocated_amount: z.number().min(0).optional().describe('Allocated amount'),
    },
    async params => {
      try {
        const result = await client.create('budgets', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_budget',
    'Update an existing budget by ID. Requires budgets:write scope.',
    {
      id: z.string().guid().describe('Budget ID'),
      year: z.number().int().min(2000).max(2100).optional().describe('Budget year'),
      funding_source: z.enum(['O&M', 'Capital']).optional().describe("'O&M' or 'Capital'"),
      module: z
        .enum(['facilities', 'infrastructure'])
        .nullable()
        .optional()
        .describe('Workspace; null for organization-wide'),
      site_id: z.string().guid().optional().describe('Site ID. Not read by the Budget tab.'),
      building_id: z
        .string()
        .guid()
        .optional()
        .describe('Building ID. Not read by the Budget tab.'),
      budgeted_amount: z.number().min(0).optional().describe('Budgeted amount'),
      allocated_amount: z.number().min(0).optional().describe('Allocated amount'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('budgets', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_budget',
    'Delete a budget by ID. Requires budgets:write scope.',
    { id: z.string().guid().describe('Budget ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('budgets', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 15. Asset Comments (scope: asset_comments)
  // ============================================================

  server.tool(
    'create_asset_comment',
    'Create a new comment on an asset. Requires asset_comments:write scope.',
    {
      asset_id: z.string().guid().describe('Asset ID (required)'),
      comment: z.string().min(1).describe('Comment text (required)'),
    },
    async params => {
      try {
        const result = await client.create('asset-comments', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset_comment',
    'Update an existing asset comment by ID. Requires asset_comments:write scope.',
    {
      id: z.string().guid().describe('Asset comment ID'),
      comment: z.string().min(1).optional().describe('Comment text'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('asset-comments', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset_comment',
    'Delete an asset comment by ID. Requires asset_comments:write scope.',
    { id: z.string().guid().describe('Asset comment ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('asset-comments', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 16. Work Order Comments (scope: work_order_comments)
  // ============================================================

  server.tool(
    'create_work_order_comment',
    'Create a new comment on a work order. Requires work_order_comments:write scope.',
    {
      work_order_id: z.string().guid().describe('Work order ID (required)'),
      comment: z.string().min(1).describe('Comment text (required)'),
    },
    async params => {
      try {
        const result = await client.create('work-order-comments', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_work_order_comment',
    'Update an existing work order comment by ID. Requires work_order_comments:write scope.',
    {
      id: z.string().guid().describe('Work order comment ID'),
      comment: z.string().min(1).optional().describe('Comment text'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('work-order-comments', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_work_order_comment',
    'Delete a work order comment by ID. Requires work_order_comments:write scope.',
    { id: z.string().guid().describe('Work order comment ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('work-order-comments', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 16b. Work Order Schedules (scope: work_order_schedules)
  // ============================================================

  server.tool(
    'create_work_order_schedule',
    "Schedule a work order for a technician on a date (one entry of a day plan). stop_order gives the position in the technician's day; leave it unset for an unordered calendar entry. Requires work_order_schedules:write scope.",
    {
      work_order_id: z.string().guid().describe('Work order ID (required)'),
      technician_id: z.string().min(1).describe('Technician Clerk user ID (required)'),
      scheduled_date: z.string().describe('Date (YYYY-MM-DD, required)'),
      scheduled_start_time: z.string().optional().describe('Start time (HH:MM)'),
      scheduled_end_time: z.string().optional().describe('End time (HH:MM)'),
      duration_minutes: z.number().int().optional().describe('Planned duration in minutes'),
      stop_order: z.number().int().optional().describe('1-based stop position in the day plan'),
      travel_time_minutes: z.number().int().optional().describe('Travel time from previous stop'),
      scheduling_notes: z.string().optional().describe('Scheduling notes'),
    },
    async params => {
      try {
        const result = await client.create('work-order-schedules', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_work_order_schedule',
    'Update a work order schedule entry by ID (date, times, stop_order, notes). work_order_id is immutable. Requires work_order_schedules:write scope.',
    {
      id: z.string().guid().describe('Work order schedule ID'),
      technician_id: z.string().min(1).optional().describe('Technician Clerk user ID'),
      scheduled_date: z.string().optional().describe('Date (YYYY-MM-DD)'),
      scheduled_start_time: z.string().optional().describe('Start time (HH:MM)'),
      scheduled_end_time: z.string().optional().describe('End time (HH:MM)'),
      duration_minutes: z.number().int().optional().describe('Planned duration in minutes'),
      stop_order: z.number().int().optional().describe('1-based stop position in the day plan'),
      travel_time_minutes: z.number().int().optional().describe('Travel time from previous stop'),
      scheduling_notes: z.string().optional().describe('Scheduling notes'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('work-order-schedules', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_work_order_schedule',
    "Delete a work order schedule entry by ID (removes the stop from the technician's day). Requires work_order_schedules:write scope.",
    { id: z.string().guid().describe('Work order schedule ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('work-order-schedules', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 17. Project Comments (scope: project_comments)
  // ============================================================

  server.tool(
    'create_project_comment',
    'Create a new comment on a project. Requires project_comments:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      content: z.string().min(1).describe('Comment content (required)'),
      parent_id: z.string().guid().optional().describe('Parent comment ID (for threading)'),
    },
    async params => {
      try {
        const result = await client.create('project-comments', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_comment',
    'Update an existing project comment by ID. Requires project_comments:write scope.',
    {
      id: z.string().guid().describe('Project comment ID'),
      content: z.string().min(1).optional().describe('Comment content'),
      parent_id: z.string().guid().optional().describe('Parent comment ID'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-comments', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_comment',
    'Delete a project comment by ID. Requires project_comments:write scope.',
    { id: z.string().guid().describe('Project comment ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-comments', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 18. Asset Costs (scope: asset_costs)
  // ============================================================

  server.tool(
    'create_asset_cost',
    'Create a new asset cost entry - the record type shown on the AssetLab "Expenses" page. Requires asset_costs:write scope.',
    {
      category: z
        .enum(['Repair', 'PM', 'Operation', 'Replacement', 'Decommission', 'Other'])
        .describe('Cost category (required)'),
      amount: z.number().min(0).describe('Cost amount (required)'),
      cost_date: z.string().describe('Cost date (ISO 8601, required)'),
      asset_id: z.string().guid().optional().describe('Asset ID'),
      site_id: z.string().guid().optional().describe('Site ID'),
      building_id: z.string().guid().optional().describe('Building ID'),
      work_order_id: z.string().guid().optional().describe('Work order ID'),
      description: z.string().optional().describe('Description'),
      invoice_number: z.string().max(200).optional().describe('Invoice number (free text)'),
      po_number: z.string().max(200).optional().describe('Purchase order number (free text)'),
      purchase_order_id: z
        .string()
        .guid()
        .optional()
        .describe(
          "Purchase order that paid this cost - resolve via list_purchase_orders. Counts against the order's remaining balance unless the cost belongs to a work order."
        ),
    },
    async params => {
      try {
        const result = await client.create('asset-costs', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset_cost',
    'Update an existing asset cost entry by ID - the record type shown on the AssetLab "Expenses" page. Requires asset_costs:write scope.',
    {
      id: z.string().guid().describe('Asset cost ID'),
      category: z
        .enum(['Repair', 'PM', 'Operation', 'Replacement', 'Decommission', 'Other'])
        .optional()
        .describe('Cost category'),
      amount: z.number().min(0).optional().describe('Cost amount'),
      cost_date: z.string().optional().describe('Cost date (ISO 8601)'),
      asset_id: z.string().guid().optional().describe('Asset ID'),
      site_id: z.string().guid().optional().describe('Site ID'),
      building_id: z.string().guid().optional().describe('Building ID'),
      work_order_id: z.string().guid().optional().describe('Work order ID'),
      description: z.string().optional().describe('Description'),
      invoice_number: z.string().max(200).optional().describe('Invoice number (free text)'),
      po_number: z.string().max(200).optional().describe('Purchase order number (free text)'),
      purchase_order_id: z
        .string()
        .guid()
        .nullable()
        .optional()
        .describe(
          "Purchase order that paid this cost - resolve via list_purchase_orders. Counts against the order's remaining balance unless the cost belongs to a work order; null clears it."
        ),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('asset-costs', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset_cost',
    'Delete an asset cost entry by ID. Requires asset_costs:write scope.',
    { id: z.string().guid().describe('Asset cost ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('asset-costs', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 19. Asset Replacement Plans (scope: asset_replacement_plans)
  // ============================================================

  server.tool(
    'create_asset_replacement_plan',
    'Create a new asset replacement plan. Requires asset_replacement_plans:write scope.',
    {
      asset_id: z.string().guid().describe('Asset ID (required)'),
      planned_replacement_year: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .describe('Planned replacement year (required)'),
      estimated_cost: z.number().min(0).optional().describe('Estimated replacement cost'),
      priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional().describe('Priority'),
      status: z
        .enum(['PLANNED', 'BUDGETED', 'APPROVED', 'COMPLETED', 'CANCELLED'])
        .optional()
        .describe('Status'),
      notes: z.string().optional().describe('Notes'),
      funding_source: z.string().max(200).optional().describe('Funding source'),
    },
    async params => {
      try {
        const result = await client.create('asset-replacement-plans', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset_replacement_plan',
    'Update an existing asset replacement plan by ID. Requires asset_replacement_plans:write scope.',
    {
      id: z.string().guid().describe('Asset replacement plan ID'),
      asset_id: z.string().guid().optional().describe('Asset ID'),
      planned_replacement_year: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .optional()
        .describe('Planned replacement year'),
      estimated_cost: z.number().min(0).optional().describe('Estimated replacement cost'),
      priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional().describe('Priority'),
      status: z
        .enum(['PLANNED', 'BUDGETED', 'APPROVED', 'COMPLETED', 'CANCELLED'])
        .optional()
        .describe('Status'),
      notes: z.string().optional().describe('Notes'),
      funding_source: z.string().max(200).optional().describe('Funding source'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('asset-replacement-plans', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset_replacement_plan',
    'Delete an asset replacement plan by ID. Requires asset_replacement_plans:write scope.',
    { id: z.string().guid().describe('Asset replacement plan ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('asset-replacement-plans', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 20. Project Tasks (scope: project_tasks)
  // ============================================================

  server.tool(
    'create_project_task',
    'Create a new project task. Requires project_tasks:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      title: z.string().min(1).max(500).describe('Task title (required)'),
      description: z.string().optional().describe('Description'),
      phase_id: z.string().guid().optional().describe('Phase ID'),
      status: z
        .enum(['todo', 'in_progress', 'completed', 'blocked', 'cancelled'])
        .optional()
        .describe('Task status'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Priority'),
      assigned_to: z.string().max(200).optional().describe('Assigned user'),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      due_date: z.string().optional().describe('Due date (ISO 8601)'),
      estimated_hours: z.number().min(0).optional().describe('Estimated hours'),
      estimated_cost: z.number().min(0).optional().describe('Estimated cost'),
    },
    async params => {
      try {
        const result = await client.create('project-tasks', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_task',
    'Update an existing project task by ID. Requires project_tasks:write scope.',
    {
      id: z.string().guid().describe('Project task ID'),
      project_id: z.string().guid().optional().describe('Project ID'),
      title: z.string().min(1).max(500).optional().describe('Task title'),
      description: z.string().optional().describe('Description'),
      phase_id: z.string().guid().optional().describe('Phase ID'),
      status: z
        .enum(['todo', 'in_progress', 'completed', 'blocked', 'cancelled'])
        .optional()
        .describe('Task status'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Priority'),
      assigned_to: z.string().max(200).optional().describe('Assigned user'),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      due_date: z.string().optional().describe('Due date (ISO 8601)'),
      estimated_hours: z.number().min(0).optional().describe('Estimated hours'),
      estimated_cost: z.number().min(0).optional().describe('Estimated cost'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-tasks', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_task',
    'Delete a project task by ID. Requires project_tasks:write scope.',
    { id: z.string().guid().describe('Project task ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-tasks', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 21. Project Milestones (scope: project_milestones)
  // ============================================================

  server.tool(
    'create_project_milestone',
    'Create a new project milestone. Requires project_milestones:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      name: z.string().min(1).max(500).describe('Milestone name (required)'),
      due_date: z.string().describe('Due date (ISO 8601, required)'),
      description: z.string().optional().describe('Description'),
      status: z
        .enum(['pending', 'completed', 'missed', 'at_risk'])
        .optional()
        .describe('Milestone status'),
      completed_date: z.string().optional().describe('Completed date (ISO 8601)'),
    },
    async params => {
      try {
        const result = await client.create('project-milestones', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_milestone',
    'Update an existing project milestone by ID. Requires project_milestones:write scope.',
    {
      id: z.string().guid().describe('Project milestone ID'),
      project_id: z.string().guid().optional().describe('Project ID'),
      name: z.string().min(1).max(500).optional().describe('Milestone name'),
      due_date: z.string().optional().describe('Due date (ISO 8601)'),
      description: z.string().optional().describe('Description'),
      status: z
        .enum(['pending', 'completed', 'missed', 'at_risk'])
        .optional()
        .describe('Milestone status'),
      completed_date: z.string().optional().describe('Completed date (ISO 8601)'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-milestones', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_milestone',
    'Delete a project milestone by ID. Requires project_milestones:write scope.',
    { id: z.string().guid().describe('Project milestone ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-milestones', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 22. Project Phases (scope: project_phases)
  // ============================================================

  server.tool(
    'create_project_phase',
    'Create a new project phase. Requires project_phases:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      name: z.string().min(1).max(500).describe('Phase name (required)'),
      description: z.string().optional().describe('Description'),
      status: z
        .enum(['pending', 'in_progress', 'completed', 'skipped'])
        .optional()
        .describe('Phase status'),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      end_date: z.string().optional().describe('End date (ISO 8601)'),
      sequence_order: z.number().int().min(0).optional().describe('Order within the project'),
    },
    async params => {
      try {
        const result = await client.create('project-phases', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_phase',
    'Update an existing project phase by ID. Requires project_phases:write scope.',
    {
      id: z.string().guid().describe('Project phase ID'),
      project_id: z.string().guid().optional().describe('Project ID'),
      name: z.string().min(1).max(500).optional().describe('Phase name'),
      description: z.string().optional().describe('Description'),
      status: z
        .enum(['pending', 'in_progress', 'completed', 'skipped'])
        .optional()
        .describe('Phase status'),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      end_date: z.string().optional().describe('End date (ISO 8601)'),
      sequence_order: z.number().int().min(0).optional().describe('Order within the project'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-phases', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_phase',
    'Delete a project phase by ID. Requires project_phases:write scope.',
    { id: z.string().guid().describe('Project phase ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-phases', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 23. Project Budget Items (scope: project_budget_items)
  // ============================================================

  server.tool(
    'create_project_budget_item',
    'Create a new project budget item. Requires project_budget_items:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      category: z
        .enum([
          'labor',
          'materials',
          'equipment',
          'subcontractors',
          'permits',
          'contingency',
          'other',
        ])
        .describe('Budget category (required)'),
      description: z.string().optional().describe('Description'),
      planned_amount: z.number().min(0).optional().describe('Planned amount'),
      actual_amount: z.number().min(0).optional().describe('Actual amount'),
    },
    async params => {
      try {
        const result = await client.create('project-budget-items', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_budget_item',
    'Update an existing project budget item by ID. Requires project_budget_items:write scope.',
    {
      id: z.string().guid().describe('Project budget item ID'),
      project_id: z.string().guid().optional().describe('Project ID'),
      category: z
        .enum([
          'labor',
          'materials',
          'equipment',
          'subcontractors',
          'permits',
          'contingency',
          'other',
        ])
        .optional()
        .describe('Budget category'),
      description: z.string().optional().describe('Description'),
      planned_amount: z.number().min(0).optional().describe('Planned amount'),
      actual_amount: z.number().min(0).optional().describe('Actual amount'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-budget-items', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_budget_item',
    'Delete a project budget item by ID. Requires project_budget_items:write scope.',
    { id: z.string().guid().describe('Project budget item ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-budget-items', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 24. Project Time Entries (scope: project_time_entries)
  // ============================================================

  server.tool(
    'create_project_time_entry',
    'Create a new project time entry. Requires project_time_entries:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      task_id: z.string().guid().describe('Task ID (required)'),
      user_id: z.string().min(1).describe('User ID (required)'),
      start_time: z.string().describe('Start time (ISO 8601 datetime, required)'),
      end_time: z.string().optional().describe('End time (ISO 8601 datetime)'),
      duration_minutes: z.number().min(0).optional().describe('Duration worked, in minutes'),
      description: z.string().optional().describe('Description'),
      user_name: z.string().max(200).optional().describe('Display name of the user'),
      is_billable: z.boolean().optional().describe('Whether the time is billable'),
    },
    async params => {
      try {
        const result = await client.create('project-time-entries', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_time_entry',
    'Update an existing project time entry by ID. Requires project_time_entries:write scope.',
    {
      id: z.string().guid().describe('Project time entry ID'),
      project_id: z.string().guid().optional().describe('Project ID'),
      task_id: z.string().guid().optional().describe('Task ID'),
      user_id: z.string().optional().describe('User ID'),
      start_time: z.string().optional().describe('Start time (ISO 8601 datetime)'),
      end_time: z.string().optional().describe('End time (ISO 8601 datetime)'),
      duration_minutes: z.number().min(0).optional().describe('Duration worked, in minutes'),
      description: z.string().optional().describe('Description'),
      user_name: z.string().max(200).optional().describe('Display name of the user'),
      is_billable: z.boolean().optional().describe('Whether the time is billable'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-time-entries', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_time_entry',
    'Delete a project time entry by ID. Requires project_time_entries:write scope.',
    { id: z.string().guid().describe('Project time entry ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-time-entries', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 25. Manufacturers (scope: manufacturers)
  // ============================================================

  server.tool(
    'create_manufacturer',
    'Create a new manufacturer. Requires manufacturers:write scope.',
    {
      name: z.string().min(1).max(500).describe('Manufacturer name (required)'),
      website: z.string().max(500).optional().describe('Website URL'),
      contact_name: z.string().max(500).optional().describe('Primary contact name'),
      contact_email: z.string().max(500).optional().describe('Contact email address'),
      contact_phone: z.string().max(100).optional().describe('Contact phone number'),
      notes: z.string().max(2000).optional().describe('Notes'),
    },
    async params => {
      try {
        const result = await client.create('manufacturers', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_manufacturer',
    'Update an existing manufacturer by ID. Requires manufacturers:write scope.',
    {
      id: z.string().guid().describe('Manufacturer ID'),
      name: z.string().min(1).max(500).optional().describe('Manufacturer name'),
      website: z.string().max(500).optional().describe('Website URL'),
      contact_name: z.string().max(500).optional().describe('Primary contact name'),
      contact_email: z.string().max(500).optional().describe('Contact email address'),
      contact_phone: z.string().max(100).optional().describe('Contact phone number'),
      notes: z.string().max(2000).optional().describe('Notes'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('manufacturers', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_manufacturer',
    'Delete a manufacturer by ID. Requires manufacturers:write scope.',
    { id: z.string().guid().describe('Manufacturer ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('manufacturers', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 26. Asset Types (scope: asset_types)
  // ============================================================

  server.tool(
    'create_asset_type',
    'Create a new asset type. Requires asset_types:write scope.',
    {
      name: z.string().min(1).max(500).describe('Asset type name (required)'),
      description: z.string().max(2000).optional().describe('Description'),
      group_id: z.string().guid().optional().describe('Group ID'),
    },
    async params => {
      try {
        const result = await client.create('asset-types', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset_type',
    'Update an existing asset type by ID. Requires asset_types:write scope.',
    {
      id: z.string().guid().describe('Asset type ID'),
      name: z.string().min(1).max(500).optional().describe('Asset type name'),
      description: z.string().max(2000).optional().describe('Description'),
      group_id: z.string().guid().optional().describe('Group ID'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('asset-types', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset_type',
    'Delete an asset type by ID. Requires asset_types:write scope.',
    { id: z.string().guid().describe('Asset type ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('asset-types', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 27. Work Categories (scope: work_categories)
  // ============================================================

  server.tool(
    'create_work_category',
    'Create a new work category. Requires work_categories:write scope.',
    {
      name: z.string().min(1).max(500).describe('Work category name (required)'),
      description: z.string().max(2000).optional().describe('Description'),
      module: WORKSPACE.optional().describe(
        'Workspace the category is offered in: facilities, infrastructure, or shared (both). Defaults to shared.'
      ),
    },
    async params => {
      try {
        const result = await client.create('work-categories', workspaceBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_work_category',
    'Update an existing work category by ID. Requires work_categories:write scope.',
    {
      id: z.string().guid().describe('Work category ID'),
      name: z.string().min(1).max(500).optional().describe('Work category name'),
      description: z.string().max(2000).optional().describe('Description'),
      module: WORKSPACE.optional().describe(
        'Move the category to a workspace: facilities, infrastructure, or shared (both).'
      ),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('work-categories', id, workspaceBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_work_category',
    'Delete a work category by ID. Requires work_categories:write scope.',
    { id: z.string().guid().describe('Work category ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('work-categories', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 28. Asset Type Groups (scope: asset_type_groups)
  // ============================================================

  server.tool(
    'create_asset_type_group',
    'Create a new asset type group. Groups organize asset types into logical categories. Requires asset_type_groups:write scope.',
    {
      name: z.string().min(1).max(500).describe('Group name (required)'),
      description: z.string().max(2000).optional().describe('Description'),
      color: z.string().max(50).optional().describe('Color hex code (e.g., #6366f1)'),
    },
    async params => {
      try {
        const result = await client.create('asset-type-groups', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset_type_group',
    'Update an existing asset type group by ID. Requires asset_type_groups:write scope.',
    {
      id: z.string().guid().describe('Asset type group ID'),
      name: z.string().min(1).max(500).optional().describe('Group name'),
      description: z.string().max(2000).optional().describe('Description'),
      color: z.string().max(50).optional().describe('Color hex code (e.g., #6366f1)'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('asset-type-groups', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset_type_group',
    'Delete an asset type group by ID. Requires asset_type_groups:write scope.',
    { id: z.string().guid().describe('Asset type group ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('asset-type-groups', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 29. Building Types (scope: building_types)
  // ============================================================

  server.tool(
    'create_building_type',
    'Create a new building type. Requires building_types:write scope.',
    {
      name: z.string().min(1).max(500).describe('Building type name (required)'),
      description: z.string().max(2000).optional().describe('Description'),
    },
    async params => {
      try {
        const result = await client.create('building-types', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_building_type',
    'Update an existing building type by ID. Requires building_types:write scope.',
    {
      id: z.string().guid().describe('Building type ID'),
      name: z.string().min(1).max(500).optional().describe('Building type name'),
      description: z.string().max(2000).optional().describe('Description'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('building-types', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_building_type',
    'Delete a building type by ID. Requires building_types:write scope.',
    { id: z.string().guid().describe('Building type ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('building-types', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 29. Location Types (scope: location_types)
  // ============================================================

  server.tool(
    'create_location_type',
    'Create a new location type. Requires location_types:write scope.',
    {
      name: z.string().min(1).max(500).describe('Location type name (required)'),
      description: z.string().max(2000).optional().describe('Description'),
    },
    async params => {
      try {
        const result = await client.create('location-types', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_location_type',
    'Update an existing location type by ID. Requires location_types:write scope.',
    {
      id: z.string().guid().describe('Location type ID'),
      name: z.string().min(1).max(500).optional().describe('Location type name'),
      description: z.string().max(2000).optional().describe('Description'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('location-types', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_location_type',
    'Delete a location type by ID. Requires location_types:write scope.',
    { id: z.string().guid().describe('Location type ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('location-types', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Phase Categories (scope: project_phase_categories)
  // ============================================================

  server.tool(
    'create_project_phase_category',
    'Create a new project phase category. Requires project_phase_categories:write scope.',
    {
      name: z.string().min(1).max(500).describe('Phase name (required), e.g. "Planning", "Design"'),
      description: z.string().max(2000).optional().describe('Description of the phase'),
      sort_order: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .optional()
        .describe('Display order (lower = first)'),
    },
    async params => {
      try {
        const result = await client.create('project-phase-categories', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_phase_category',
    'Update an existing project phase category by ID. Requires project_phase_categories:write scope.',
    {
      id: z.string().guid().describe('Project phase category ID'),
      name: z.string().min(1).max(500).optional().describe('Phase name'),
      description: z.string().max(2000).optional().describe('Description'),
      sort_order: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .optional()
        .describe('Display order (lower = first)'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-phase-categories', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_phase_category',
    'Delete a project phase category by ID. Requires project_phase_categories:write scope.',
    { id: z.string().guid().describe('Project phase category ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-phase-categories', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 30. Cost Categories (scope: cost_categories)
  // ============================================================

  server.tool(
    'create_cost_category',
    'Create a new cost category. Requires cost_categories:write scope.',
    {
      name: z.string().min(1).max(500).describe('Cost category name (required)'),
      parent_id: z.string().guid().optional().describe('Parent cost category ID'),
      is_active: z.boolean().optional().describe('Whether the category is active'),
    },
    async params => {
      try {
        const result = await client.create('cost-categories', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_cost_category',
    'Update an existing cost category by ID. Requires cost_categories:write scope.',
    {
      id: z.string().guid().describe('Cost category ID'),
      name: z.string().min(1).max(500).optional().describe('Cost category name'),
      parent_id: z.string().guid().optional().describe('Parent cost category ID'),
      is_active: z.boolean().optional().describe('Whether the category is active'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('cost-categories', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_cost_category',
    'Delete a cost category by ID. Requires cost_categories:write scope.',
    { id: z.string().guid().describe('Cost category ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('cost-categories', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 31. Part Categories (scope: part_categories)
  // ============================================================

  server.tool(
    'create_part_category',
    'Create a new part category. Requires part_categories:write scope.',
    {
      name: z.string().min(1).max(500).describe('Part category name (required)'),
      description: z.string().max(2000).optional().describe('Description'),
      module: WORKSPACE.optional().describe(
        'Workspace the category is offered in: facilities, infrastructure, or shared (both). Defaults to shared.'
      ),
    },
    async params => {
      try {
        const result = await client.create('part-categories', workspaceBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_part_category',
    'Update an existing part category by ID. Requires part_categories:write scope.',
    {
      id: z.string().guid().describe('Part category ID'),
      name: z.string().min(1).max(500).optional().describe('Part category name'),
      description: z.string().max(2000).optional().describe('Description'),
      module: WORKSPACE.optional().describe(
        'Move the category to a workspace: facilities, infrastructure, or shared (both).'
      ),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('part-categories', id, workspaceBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_part_category',
    'Delete a part category by ID. Requires part_categories:write scope.',
    { id: z.string().guid().describe('Part category ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('part-categories', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Asset Parts (scope: asset_parts)
  // ============================================================

  server.tool(
    'create_asset_part',
    'Link a part to an asset (creates an asset-part association). Requires asset_parts:write scope.',
    {
      asset_id: z.string().guid().describe('Asset ID (required)'),
      part_id: z.string().guid().describe('Part ID (required)'),
      quantity: z.number().min(0).optional().describe('Quantity of this part on the asset'),
    },
    async params => {
      try {
        const result = await client.create('asset-parts', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset_part',
    'Update the quantity of an asset-part association by ID. Requires asset_parts:write scope.',
    {
      id: z.string().guid().describe('Asset-part association ID'),
      quantity: z.number().min(0).optional().describe('New quantity'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('asset-parts', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset_part',
    'Remove a part from an asset by association ID. Requires asset_parts:write scope.',
    { id: z.string().guid().describe('Asset-part association ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('asset-parts', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 32. Systems (scope: systems)
  // ============================================================

  server.tool(
    'create_system',
    'Create a new system. Requires systems:write scope.',
    {
      name: z.string().min(1).max(500).describe('System name (required)'),
      description: z.string().max(2000).optional().describe('Description'),
      system_group_id: z.string().guid().optional().describe('System group ID'),
      crv_multiplier: z.number().min(0).optional().describe('CRV multiplier'),
    },
    async params => {
      try {
        const result = await client.create('systems', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_system',
    'Update an existing system by ID. Requires systems:write scope.',
    {
      id: z.string().guid().describe('System ID'),
      name: z.string().min(1).max(500).optional().describe('System name'),
      description: z.string().max(2000).optional().describe('Description'),
      system_group_id: z.string().guid().optional().describe('System group ID'),
      crv_multiplier: z.number().min(0).optional().describe('CRV multiplier'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('systems', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_system',
    'Delete a system by ID. Requires systems:write scope.',
    { id: z.string().guid().describe('System ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('systems', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 33. System Classes (scope: systems)
  // ============================================================

  server.tool(
    'create_system_class',
    'Create a new system class (top-level classification, e.g., "HVAC & Mechanical", "Material Handling"). Requires systems:write scope.',
    {
      name: z.string().min(1).max(500).describe('System class name (required)'),
      description: z.string().max(2000).optional().describe('Description'),
    },
    async params => {
      try {
        const result = await client.create('system-classes', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_system_class',
    'Update an existing system class by ID. Requires systems:write scope.',
    {
      id: z.string().guid().describe('System class ID'),
      name: z.string().min(1).max(500).optional().describe('System class name'),
      description: z.string().max(2000).optional().describe('Description'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('system-classes', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_system_class',
    'Delete a system class by ID. Requires systems:write scope.',
    { id: z.string().guid().describe('System class ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('system-classes', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 34. System Groups (scope: systems)
  // ============================================================

  server.tool(
    'create_system_group',
    'Create a new system group (category under a system class, e.g., "Heating", "Cooling"). Requires systems:write scope.',
    {
      name: z.string().min(1).max(500).describe('System group name (required)'),
      description: z.string().max(2000).optional().describe('Description'),
      system_class_id: z.string().guid().optional().describe('Parent system class ID'),
    },
    async params => {
      try {
        const result = await client.create('system-groups', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_system_group',
    'Update an existing system group by ID. Requires systems:write scope.',
    {
      id: z.string().guid().describe('System group ID'),
      name: z.string().min(1).max(500).optional().describe('System group name'),
      description: z.string().max(2000).optional().describe('Description'),
      system_class_id: z.string().guid().optional().describe('Parent system class ID'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('system-groups', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_system_group',
    'Delete a system group by ID. Requires systems:write scope.',
    { id: z.string().guid().describe('System group ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('system-groups', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 35. Vendor-Site Assignments (scope: vendor_site_assignments)
  //     POST + DELETE only - no PATCH/update
  // ============================================================

  server.tool(
    'create_vendor_site_assignment',
    'Assign a vendor to a site. Requires vendor_site_assignments:write scope.',
    {
      vendor_id: z.string().guid().describe('Vendor ID (required)'),
      site_id: z.string().guid().describe('Site ID (required)'),
    },
    async params => {
      try {
        const result = await client.create('vendor-site-assignments', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_vendor_site_assignment',
    'Remove a vendor-site assignment by ID. Requires vendor_site_assignments:write scope.',
    { id: z.string().guid().describe('Vendor-site assignment ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('vendor-site-assignments', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 34. Contract-Sites (scope: contract_sites)
  //     POST + DELETE only - no PATCH/update
  // ============================================================

  server.tool(
    'create_contract_site',
    'Assign a contract to a site. Requires contract_sites:write scope.',
    {
      contract_id: z.string().guid().describe('Contract ID (required)'),
      site_id: z.string().guid().describe('Site ID (required)'),
    },
    async params => {
      try {
        const result = await client.create('contract-sites', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_contract_site',
    'Remove a contract from a site. Requires contract_sites:write scope. An assignment is identified by its contract and site; it has no id of its own.',
    {
      contract_id: z.string().guid().describe('Contract ID (required)'),
      site_id: z.string().guid().describe('Site ID (required)'),
    },
    async ({ contract_id, site_id }) => {
      try {
        const result = await client.remove('contract-sites', `${contract_id}:${site_id}`)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 35. Custom Field Definitions (scope: custom_fields)
  // ============================================================

  server.tool(
    'create_custom_field_definition',
    'Create a new custom field definition. Requires custom_fields:write scope.',
    {
      entity_type: z
        .string()
        .min(1)
        .max(100)
        .describe('Entity type this field applies to (required)'),
      field_name: z.string().min(1).max(200).describe('Field name / key (required)'),
      field_type: z
        .enum(['text', 'number', 'date', 'boolean', 'select'])
        .describe('Field data type (required)'),
      field_label: z.string().max(200).optional().describe('Display label'),
      field_options: z.array(z.string()).optional().describe('Options for select-type fields'),
      is_required: z.boolean().optional().describe('Whether the field is required'),
      display_order: z.number().int().min(0).optional().describe('Display order'),
    },
    async params => {
      try {
        const result = await client.create('custom-field-definitions', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_custom_field_definition',
    'Update an existing custom field definition by ID. Requires custom_fields:write scope.',
    {
      id: z.string().guid().describe('Custom field definition ID'),
      entity_type: z.string().min(1).max(100).optional().describe('Entity type'),
      field_name: z.string().min(1).max(200).optional().describe('Field name / key'),
      field_type: z
        .enum(['text', 'number', 'date', 'boolean', 'select'])
        .optional()
        .describe('Field data type'),
      field_label: z.string().max(200).optional().describe('Display label'),
      field_options: z.array(z.string()).optional().describe('Options for select-type fields'),
      is_required: z.boolean().optional().describe('Whether the field is required'),
      display_order: z.number().int().min(0).optional().describe('Display order'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('custom-field-definitions', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_custom_field_definition',
    'Delete a custom field definition by ID. Requires custom_fields:write scope.',
    { id: z.string().guid().describe('Custom field definition ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('custom-field-definitions', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // 36. Custom Field Values (scope: custom_fields)
  // ============================================================

  server.tool(
    'create_custom_field_value',
    "Create (upsert) a custom field value for an entity. The table stores values in typed columns - prefer setting the one that matches the field definition's field_type: value_text (text/select), value_number (number), value_date (date, ISO YYYY-MM-DD), value_boolean (boolean). Alternatively pass a single `value` string and the server will dispatch it to the right column based on field_type. Writes upsert on (entity_id, field_definition_id) so replaying a batch is idempotent. Requires custom_fields:write scope.",
    {
      entity_id: z.string().guid().describe('Entity ID - e.g. asset.id, work_order.id (required)'),
      field_definition_id: z
        .string()
        .guid()
        .describe(
          'Custom field definition ID - resolve via list_custom_field_definitions (required)'
        ),
      value_text: z
        .string()
        .max(5000)
        .nullable()
        .optional()
        .describe('Text value (use for field_type=text or select)'),
      value_number: z
        .number()
        .nullable()
        .optional()
        .describe('Numeric value (use for field_type=number)'),
      value_date: z
        .string()
        .nullable()
        .optional()
        .describe('Date value, ISO YYYY-MM-DD (use for field_type=date)'),
      value_boolean: z
        .boolean()
        .nullable()
        .optional()
        .describe('Boolean value (use for field_type=boolean)'),
      value: z
        .string()
        .max(5000)
        .optional()
        .describe(
          "Legacy single-value shim - server dispatches to the correct typed column based on the field definition's field_type. Ignored if any value_* typed column is set."
        ),
    },
    async params => {
      try {
        const result = await client.create('custom-field-values', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_custom_field_value',
    "Update an existing custom field value by ID. Set whichever typed column matches the definition's field_type (value_text / value_number / value_date / value_boolean), or pass a single `value` and the server will dispatch it. Requires custom_fields:write scope.",
    {
      id: z.string().guid().describe('Custom field value ID'),
      entity_id: z.string().guid().optional().describe('Entity ID'),
      field_definition_id: z
        .string()
        .guid()
        .optional()
        .describe(
          'Custom field definition ID - required when using the `value` fallback if you want to avoid the server fetching it'
        ),
      value_text: z.string().max(5000).nullable().optional().describe('Text value'),
      value_number: z.number().nullable().optional().describe('Numeric value'),
      value_date: z.string().nullable().optional().describe('Date value, ISO YYYY-MM-DD'),
      value_boolean: z.boolean().nullable().optional().describe('Boolean value'),
      value: z
        .string()
        .max(5000)
        .optional()
        .describe('Legacy single-value shim - server dispatches based on field_type'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('custom-field-values', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_custom_field_value',
    'Delete a custom field value by ID. Requires custom_fields:write scope.',
    { id: z.string().guid().describe('Custom field value ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('custom-field-values', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Parts (scope: parts) - moved from tools.ts
  // ============================================================

  server.tool(
    'create_part',
    'Create a new part/inventory item. Requires parts:write scope.',
    {
      name: z.string().min(1).max(500).describe('Part name (required)'),
      part_number: z.string().max(200).optional().describe('Part number / SKU'),
      category: z.string().max(200).optional().describe('Category label'),
      supplier: z
        .string()
        .max(500)
        .optional()
        .describe('DEPRECATED - legacy free-text supplier name. Use supplier_id instead.'),
      supplier_id: z.string().guid().optional().describe('Vendor ID (resolve via list_vendors)'),
      cost: z.number().min(0).optional().describe('Unit cost'),
      quantity: z
        .number()
        .int()
        .min(0)
        .max(10_000_000)
        .optional()
        .describe('Current stock quantity'),
      desired_quantity: z
        .number()
        .int()
        .min(0)
        .max(10_000_000)
        .optional()
        .describe('Target / reorder quantity'),
      specific_location: z.string().max(500).optional().describe('Storage location description'),
      site_id: z.string().guid().optional().describe('Site ID'),
      building_id: z.string().guid().optional().describe('Building ID'),
      location_id: z.string().guid().optional().describe('Location ID'),
    },
    async params => {
      try {
        const result = await client.create('parts', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_part',
    'Update an existing part/inventory item by ID. Requires parts:write scope.',
    {
      id: z.string().guid().describe('Part ID'),
      name: z.string().min(1).max(500).optional().describe('Part name'),
      part_number: z.string().max(200).optional().describe('Part number / SKU'),
      category: z.string().max(200).optional().describe('Category label'),
      supplier: z
        .string()
        .max(500)
        .optional()
        .describe('DEPRECATED - legacy free-text supplier name. Use supplier_id instead.'),
      supplier_id: z.string().guid().optional().describe('Vendor ID (resolve via list_vendors)'),
      cost: z.number().min(0).optional().describe('Unit cost'),
      quantity: z
        .number()
        .int()
        .min(0)
        .max(10_000_000)
        .optional()
        .describe('Current stock quantity'),
      desired_quantity: z
        .number()
        .int()
        .min(0)
        .max(10_000_000)
        .optional()
        .describe('Target / reorder quantity'),
      specific_location: z.string().max(500).optional().describe('Storage location description'),
      site_id: z.string().guid().optional().describe('Site ID'),
      building_id: z.string().guid().optional().describe('Building ID'),
      location_id: z.string().guid().optional().describe('Location ID'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('parts', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_part',
    'Delete a part/inventory item by ID. Requires parts:write scope.',
    { id: z.string().guid().describe('Part ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('parts', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Upload URLs
  // ============================================================

  server.tool(
    'create_upload_url',
    'Generate a signed upload URL for uploading a file to AssetLab storage. Returns a signed_url to PUT the file to, and the storage path to store on the record. IMPORTANT - When a user wants to upload a file, always clarify the target. File upload paths: (1) Asset IMAGE: bucket "asset-images" → update_asset with image_url. (2) Asset DOCUMENT (O&M, warranty, spec): bucket "documents" → create_asset_document. (3) Work order IMAGE: bucket "attachments" → update_work_order with image_url. (4) Work order/request/PM ATTACHMENT: bucket "attachments" → create_attachment with the parent ID. (5) Project DOCUMENT: bucket "project-documents" → create_project_document. (6) Contract DOCUMENT: bucket "contract-documents" → create_contract_document. Always ask the user which type they mean if ambiguous. Requires upload_urls:write scope.',
    {
      bucket: z
        .enum([
          'documents',
          'attachments',
          'project-documents',
          'contract-documents',
          'asset-images',
        ])
        .describe('Storage bucket (required). Use "asset-images" for asset photos.'),
      file_name: z.string().min(1).max(500).describe('File name including extension (required)'),
    },
    async params => {
      try {
        const result = await client.create('upload-urls', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'upload_file',
    'Upload a file to AssetLab storage by sending its bytes inline (base64). The AssetLab backend performs the storage upload server-side - use this tool when the client cannot PUT directly to Supabase Storage (e.g. Claude integrations whose outbound network blocks arbitrary supabase.co hosts). Returns { path, bucket, file_size, content_type }. After uploading, pass path to the appropriate record tool (update_asset image_url, create_asset_document file_path, update_work_order image_url, create_attachment file_url, create_project_document file_path, create_contract_document file_path). Server limit is ~10 MB decoded; MCP arg ceiling effectively caps file size around 700 KB-1 MB. For larger files, use create_upload_url instead. Requires upload_urls:write scope.',
    {
      bucket: z
        .enum([
          'documents',
          'attachments',
          'project-documents',
          'contract-documents',
          'asset-images',
        ])
        .describe(
          'Storage bucket (required). Use "asset-images" for asset photos, "attachments" for work-order/PM attachments.'
        ),
      file_name: z.string().min(1).max(500).describe('File name including extension (required)'),
      content_base64: z
        .string()
        .min(1)
        .describe(
          'File contents base64-encoded (required). Data URI prefixes like "data:image/png;base64," are stripped automatically.'
        ),
      content_type: z
        .string()
        .max(200)
        .optional()
        .describe(
          'MIME type (e.g. image/jpeg, application/pdf). Defaults to application/octet-stream.'
        ),
    },
    async params => {
      try {
        const result = await client.create('upload-files', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Asset Documents (scope: asset_documents)
  // ============================================================

  server.tool(
    'create_asset_document',
    'Create an asset document record (after uploading the file via create_upload_url). Requires asset_documents:write scope.',
    {
      name: z.string().min(1).max(500).describe('Document name (required)'),
      file_path: z
        .string()
        .min(1)
        .max(2000)
        .describe('Storage path from upload URL response (required)'),
      asset_id: z.string().guid().describe('Asset ID this document belongs to (required)'),
      category: z
        .enum(['om', 'commissioning', 'warranty', 'installation', 'specification', 'other'])
        .optional()
        .describe('Document category'),
      description: z.string().optional().describe('Description'),
      file_type: z.string().max(200).optional().describe('MIME type'),
      file_size: z.number().min(0).optional().describe('File size in bytes'),
      user_id: z.string().max(200).optional().describe('Uploader user ID'),
    },
    async params => {
      try {
        const result = await client.create('asset-documents', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset_document',
    'Update an asset document by ID. Requires asset_documents:write scope.',
    {
      id: z.string().guid().describe('Asset document ID'),
      name: z.string().min(1).max(500).optional().describe('Document name'),
      file_path: z.string().max(2000).optional().describe('Storage path'),
      asset_id: z.string().guid().optional().describe('Asset ID'),
      category: z
        .enum(['om', 'commissioning', 'warranty', 'installation', 'specification', 'other'])
        .optional()
        .describe('Document category'),
      description: z.string().optional().describe('Description'),
      file_type: z.string().max(200).optional().describe('MIME type'),
      file_size: z.number().min(0).optional().describe('File size in bytes'),
      user_id: z.string().max(200).optional().describe('Uploader user ID'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('asset-documents', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset_document',
    'Delete an asset document by ID. Requires asset_documents:write scope.',
    { id: z.string().guid().describe('Asset document ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('asset-documents', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Attachments (scope: attachments)
  // ============================================================

  server.tool(
    'create_attachment',
    'Create an attachment record linked to a work order, work request, PM schedule, or PM template. Exactly one parent ID must be provided. Requires attachments:write scope.',
    {
      file_url: z.string().min(1).max(2000).describe('File URL / storage path (required)'),
      file_name: z.string().min(1).max(500).describe('File name (required)'),
      file_size: z.number().min(0).optional().describe('File size in bytes'),
      file_type: z.string().max(200).optional().describe('MIME type'),
      uploaded_by: z.string().max(200).optional().describe('Uploader user ID'),
      description: z.string().optional().describe('Description'),
      work_order_id: z
        .string()
        .guid()
        .optional()
        .describe('Work order ID (exactly one parent required)'),
      work_request_id: z
        .string()
        .guid()
        .optional()
        .describe('Work request ID (exactly one parent required)'),
      pm_schedule_id: z
        .string()
        .guid()
        .optional()
        .describe('PM schedule ID (exactly one parent required)'),
      pm_template_id: z
        .string()
        .guid()
        .optional()
        .describe('PM template ID (exactly one parent required)'),
    },
    async params => {
      try {
        const result = await client.create('attachments', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_attachment',
    'Update an attachment by ID. Requires attachments:write scope.',
    {
      id: z.string().guid().describe('Attachment ID'),
      file_url: z.string().max(2000).optional().describe('File URL / storage path'),
      file_name: z.string().max(500).optional().describe('File name'),
      file_size: z.number().min(0).optional().describe('File size in bytes'),
      file_type: z.string().max(200).optional().describe('MIME type'),
      uploaded_by: z.string().max(200).optional().describe('Uploader user ID'),
      description: z.string().optional().describe('Description'),
      work_order_id: z.string().guid().optional().describe('Work order ID'),
      work_request_id: z.string().guid().optional().describe('Work request ID'),
      pm_schedule_id: z.string().guid().optional().describe('PM schedule ID'),
      pm_template_id: z.string().guid().optional().describe('PM template ID'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('attachments', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_attachment',
    'Delete an attachment by ID. Requires attachments:write scope.',
    { id: z.string().guid().describe('Attachment ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('attachments', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Documents (scope: project_documents)
  // ============================================================

  server.tool(
    'create_project_document',
    'Create a project document record. Requires project_documents:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      name: z.string().min(1).max(500).describe('Document name (required)'),
      file_path: z
        .string()
        .min(1)
        .max(2000)
        .describe('Storage path from upload URL response (required)'),
      uploaded_by: z.string().min(1).max(200).describe('Uploader user ID (required)'),
      folder_id: z.string().guid().optional().describe('Folder ID'),
      description: z.string().optional().describe('Description'),
      file_size: z.number().min(0).optional().describe('File size in bytes'),
      file_type: z.string().max(200).optional().describe('MIME type'),
    },
    async params => {
      try {
        const result = await client.create('project-documents', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_document',
    'Update a project document by ID. Requires project_documents:write scope.',
    {
      id: z.string().guid().describe('Project document ID'),
      project_id: z.string().guid().optional().describe('Project ID'),
      name: z.string().min(1).max(500).optional().describe('Document name'),
      file_path: z.string().max(2000).optional().describe('Storage path'),
      uploaded_by: z.string().max(200).optional().describe('Uploader user ID'),
      folder_id: z.string().guid().optional().describe('Folder ID'),
      description: z.string().optional().describe('Description'),
      file_size: z.number().min(0).optional().describe('File size in bytes'),
      file_type: z.string().max(200).optional().describe('MIME type'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-documents', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_document',
    'Delete a project document by ID. Requires project_documents:write scope.',
    { id: z.string().guid().describe('Project document ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-documents', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Contract Documents (scope: contract_documents)
  // ============================================================

  server.tool(
    'create_contract_document',
    'Create a contract document record. Requires contract_documents:write scope.',
    {
      contract_id: z.string().guid().describe('Contract ID (required)'),
      file_name: z.string().min(1).max(500).describe('File name (required)'),
      file_path: z
        .string()
        .min(1)
        .max(2000)
        .describe('Storage path from upload URL response (required)'),
      file_size: z.number().min(0).optional().describe('File size in bytes'),
      file_type: z.string().max(200).optional().describe('MIME type'),
      uploaded_by: z.string().max(200).optional().describe('Uploader user ID'),
    },
    async params => {
      try {
        const result = await client.create('contract-documents', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_contract_document',
    'Update a contract document by ID. Requires contract_documents:write scope.',
    {
      id: z.string().guid().describe('Contract document ID'),
      contract_id: z.string().guid().optional().describe('Contract ID'),
      file_name: z.string().max(500).optional().describe('File name'),
      file_path: z.string().max(2000).optional().describe('Storage path'),
      file_size: z.number().min(0).optional().describe('File size in bytes'),
      file_type: z.string().max(200).optional().describe('MIME type'),
      uploaded_by: z.string().max(200).optional().describe('Uploader user ID'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('contract-documents', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_contract_document',
    'Delete a contract document by ID. Requires contract_documents:write scope.',
    { id: z.string().guid().describe('Contract document ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('contract-documents', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Team Members
  // ============================================================

  server.tool(
    'create_project_team_member',
    'Add a team member to a project. Requires project_team_members:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      user_id: z.string().min(1).max(200).describe('Clerk user ID (required)'),
      role: z.string().min(1).max(100).describe('Role on the project (required)'),
      responsibilities: z.string().optional().describe('Description of responsibilities'),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      end_date: z.string().optional().describe('End date (ISO 8601)'),
      is_active: z.boolean().optional().describe('Whether member is currently active'),
    },
    async params => {
      try {
        const result = await client.create('project-team-members', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_team_member',
    'Update a project team member by ID. Requires project_team_members:write scope.',
    {
      id: z.string().guid().describe('Project team member ID'),
      project_id: z.string().guid().optional().describe('Project ID'),
      user_id: z.string().min(1).max(200).optional().describe('Clerk user ID'),
      role: z.string().min(1).max(100).optional().describe('Role on the project'),
      responsibilities: z.string().optional().describe('Description of responsibilities'),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      end_date: z.string().optional().describe('End date (ISO 8601)'),
      is_active: z.boolean().optional().describe('Whether member is currently active'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-team-members', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_team_member',
    'Remove a team member from a project by ID. Requires project_team_members:write scope.',
    { id: z.string().guid().describe('Project team member ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-team-members', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Task Dependencies
  // ============================================================

  server.tool(
    'create_project_task_dependency',
    'Create a dependency between two project tasks. Requires project_task_dependencies:write scope.',
    {
      task_id: z.string().guid().describe('Task ID (the dependent task, required)'),
      depends_on_task_id: z.string().guid().describe('Task ID that must complete first (required)'),
      dependency_type: z
        .enum(['finish_to_start', 'start_to_start', 'finish_to_finish', 'start_to_finish'])
        .optional()
        .describe('Dependency type (default: finish_to_start)'),
    },
    async params => {
      try {
        const result = await client.create('project-task-dependencies', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_task_dependency',
    'Delete a task dependency by ID. Requires project_task_dependencies:write scope.',
    { id: z.string().guid().describe('Project task dependency ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-task-dependencies', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Updates
  // ============================================================

  server.tool(
    'create_project_update',
    'Create a periodic project status update. Requires project_updates:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      author_id: z.string().min(1).max(200).describe('Author Clerk user ID (required)'),
      timeframe: z
        .enum(['monthly', 'quarterly', 'bi-annually', 'annually'])
        .describe('Update timeframe (required)'),
      period_year: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .describe('Year for this update period (required)'),
      period_value: z
        .string()
        .min(1)
        .max(20)
        .describe('Period value - 1-12 for monthly, 1-4 for quarterly, etc. (required)'),
      content: z.string().min(1).describe('Update content (required)'),
      title: z.string().max(500).optional().describe('Optional custom title'),
    },
    async params => {
      try {
        const result = await client.create('project-updates', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_update',
    'Update an existing project update by ID. Requires project_updates:write scope.',
    {
      id: z.string().guid().describe('Project update ID'),
      project_id: z.string().guid().optional().describe('Project ID'),
      author_id: z.string().min(1).max(200).optional().describe('Author Clerk user ID'),
      timeframe: z
        .enum(['monthly', 'quarterly', 'bi-annually', 'annually'])
        .optional()
        .describe('Update timeframe'),
      period_year: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .optional()
        .describe('Year for this update period'),
      period_value: z.string().min(1).max(20).optional().describe('Period value'),
      content: z.string().min(1).optional().describe('Update content'),
      title: z.string().max(500).optional().describe('Optional custom title'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-updates', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_update',
    'Delete a project update by ID. Requires project_updates:write scope.',
    { id: z.string().guid().describe('Project update ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-updates', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Cost Snapshots
  // ============================================================

  server.tool(
    'create_project_cost_snapshot',
    'Record a cost snapshot for a project at a point in time. Requires project_cost_snapshots:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      snapshot_date: z.string().describe('Snapshot date (ISO 8601, required)'),
      total_budget: z.number().min(0).describe('Total budget amount (required)'),
      actual_cost: z.number().min(0).describe('Actual cost to date (required)'),
      forecasted_cost: z.number().min(0).optional().describe('Forecasted total cost'),
      percent_complete: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Completion percentage (0-100)'),
    },
    async params => {
      try {
        const result = await client.create('project-cost-snapshots', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_cost_snapshot',
    'Delete a project cost snapshot by ID. Requires project_cost_snapshots:write scope.',
    { id: z.string().guid().describe('Project cost snapshot ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-cost-snapshots', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Locations
  // ============================================================

  server.tool(
    'create_project_location',
    'Link a location to a project. Requires project_locations:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      location_id: z.string().guid().describe('Location ID (required)'),
    },
    async params => {
      try {
        const result = await client.create('project-locations', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_location',
    'Remove a location from a project by ID. Requires project_locations:write scope.',
    { id: z.string().guid().describe('Project location ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-locations', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Sites
  // ============================================================

  server.tool(
    'create_project_site',
    'Link a site to a project. Requires project_sites:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      site_id: z.string().guid().describe('Site ID (required)'),
    },
    async params => {
      try {
        const result = await client.create('project-sites', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_site',
    'Remove a site from a project by ID. Requires project_sites:write scope.',
    { id: z.string().guid().describe('Project site ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-sites', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Buildings
  // ============================================================

  server.tool(
    'create_project_building',
    'Link a building to a project. Requires project_buildings:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      building_id: z.string().guid().describe('Building ID (required)'),
    },
    async params => {
      try {
        const result = await client.create('project-buildings', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_building',
    'Remove a building from a project by ID. Requires project_buildings:write scope.',
    { id: z.string().guid().describe('Project building ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-buildings', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Systems
  // ============================================================

  server.tool(
    'create_project_system',
    'Link a system to a project. Requires project_systems:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      system_id: z.string().guid().describe('System ID (required)'),
    },
    async params => {
      try {
        const result = await client.create('project-systems', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_system',
    'Remove a system from a project by ID. Requires project_systems:write scope.',
    { id: z.string().guid().describe('Project system ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-systems', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project System Classes
  // ============================================================

  server.tool(
    'create_project_system_class',
    'Link a system class to a project. Requires project_system_classes:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      system_class_id: z.string().guid().describe('System class ID (required)'),
    },
    async params => {
      try {
        const result = await client.create('project-system-classes', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_system_class',
    'Remove a system class from a project by ID. Requires project_system_classes:write scope.',
    { id: z.string().guid().describe('Project system class ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-system-classes', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project System Groups
  // ============================================================

  server.tool(
    'create_project_system_group',
    'Link a system group to a project. Requires project_system_groups:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      system_group_id: z.string().guid().describe('System group ID (required)'),
    },
    async params => {
      try {
        const result = await client.create('project-system-groups', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_system_group',
    'Remove a system group from a project by ID. Requires project_system_groups:write scope.',
    { id: z.string().guid().describe('Project system group ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-system-groups', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Risks (scope: project_risks)
  // ============================================================

  server.tool(
    'create_project_risk',
    'Create a new project risk. Requires project_risks:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      title: z.string().min(1).max(500).describe('Risk title (required)'),
      description: z.string().optional().describe('Risk description'),
      category: z
        .enum(['technical', 'financial', 'schedule', 'resource', 'external'])
        .optional()
        .describe('Risk category'),
      probability: z.enum(['low', 'medium', 'high']).optional().describe('Probability level'),
      impact: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Impact level'),
      status: z
        .enum(['identified', 'analyzing', 'mitigating', 'resolved', 'accepted'])
        .optional()
        .describe('Risk status (default: identified)'),
      mitigation_plan: z.string().optional().describe('Mitigation plan'),
      contingency_plan: z.string().optional().describe('Contingency plan'),
      owner_id: z.string().max(200).optional().describe('Risk owner (Clerk user ID)'),
      due_date: z.string().optional().describe('Due date (ISO 8601)'),
      created_by: z.string().max(200).optional().describe('Creator (Clerk user ID)'),
    },
    async params => {
      try {
        const result = await client.create('project-risks', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_risk',
    'Update an existing project risk by ID. Requires project_risks:write scope.',
    {
      id: z.string().guid().describe('Project risk ID'),
      project_id: z.string().guid().optional().describe('Project ID'),
      title: z.string().min(1).max(500).optional().describe('Risk title'),
      description: z.string().optional().describe('Risk description'),
      category: z
        .enum(['technical', 'financial', 'schedule', 'resource', 'external'])
        .optional()
        .describe('Risk category'),
      probability: z.enum(['low', 'medium', 'high']).optional().describe('Probability level'),
      impact: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Impact level'),
      status: z
        .enum(['identified', 'analyzing', 'mitigating', 'resolved', 'accepted'])
        .optional()
        .describe('Risk status'),
      mitigation_plan: z.string().optional().describe('Mitigation plan'),
      contingency_plan: z.string().optional().describe('Contingency plan'),
      owner_id: z.string().max(200).optional().describe('Risk owner (Clerk user ID)'),
      due_date: z.string().optional().describe('Due date (ISO 8601)'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-risks', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_risk',
    'Delete a project risk by ID. Requires project_risks:write scope.',
    { id: z.string().guid().describe('Project risk ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-risks', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project Assets
  // ============================================================

  server.tool(
    'create_project_asset',
    'Link an asset to a project. Requires project_assets:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      asset_id: z.string().guid().describe('Asset ID (required)'),
    },
    async params => {
      try {
        const result = await client.create('project-assets', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_asset',
    'Remove an asset from a project by ID. Requires project_assets:write scope.',
    { id: z.string().guid().describe('Project asset ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-assets', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Level of Service: Service Areas (scope: service_areas)
  // ============================================================

  server.tool(
    'create_service_area',
    'Create a new service area for Level of Service tracking. Requires service_areas:write scope. After creating, link system classes via create_service_area_system_class and sites via create_service_area_site.',
    {
      name: z.string().min(1).max(500).describe('Service area name (required, unique per tenant)'),
      description: z.string().max(2000).optional().describe('Description'),
      icon: z.string().max(200).optional().describe('Icon name (e.g., "droplets" for water)'),
      color: z.string().max(50).optional().describe('Hex color code (e.g., "#3B82F6")'),
      sort_order: z.number().int().min(0).optional().describe('Sort order for display'),
      is_active: z
        .boolean()
        .optional()
        .describe('Whether the service area is active (default: true)'),
    },
    async params => {
      try {
        const result = await client.create('service-areas', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_service_area',
    'Update an existing service area by ID. Requires service_areas:write scope.',
    {
      id: z.string().guid().describe('Service area ID'),
      name: z.string().min(1).max(500).optional().describe('Service area name'),
      description: z.string().max(2000).optional().describe('Description'),
      icon: z.string().max(200).optional().describe('Icon name'),
      color: z.string().max(50).optional().describe('Hex color code'),
      sort_order: z.number().int().min(0).optional().describe('Sort order'),
      is_active: z.boolean().optional().describe('Active status'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('service-areas', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_service_area',
    'Delete a service area by ID. WARNING: This also deletes all linked measures, measurements, and junction records. Requires service_areas:write scope.',
    { id: z.string().guid().describe('Service area ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('service-areas', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Level of Service: Service Area System Classes (scope: service_areas)
  // ============================================================

  server.tool(
    'create_service_area_system_class',
    'Link a system class to a service area. Requires service_areas:write scope. Resolve IDs first: list_service_areas → service_area_id, list_system_classes → system_class_id.',
    {
      service_area_id: z.string().guid().describe('Service area ID (required)'),
      system_class_id: z.string().guid().describe('System class ID (required)'),
    },
    async params => {
      try {
        const result = await client.create('service-area-system-classes', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_service_area_system_class',
    'Remove a system class link from a service area. Requires service_areas:write scope.',
    { id: z.string().guid().describe('Service area system class link ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('service-area-system-classes', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Level of Service: Service Area Sites (scope: service_areas)
  // ============================================================

  server.tool(
    'create_service_area_site',
    'Link a site to a service area (optional scoping). Requires service_areas:write scope. Resolve IDs first: list_service_areas → service_area_id, list_sites → site_id.',
    {
      service_area_id: z.string().guid().describe('Service area ID (required)'),
      site_id: z.string().guid().describe('Site ID (required)'),
    },
    async params => {
      try {
        const result = await client.create('service-area-sites', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_service_area_site',
    'Remove a site link from a service area. Requires service_areas:write scope.',
    { id: z.string().guid().describe('Service area site link ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('service-area-sites', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Level of Service: Measures (scope: los_measures)
  // ============================================================

  server.tool(
    'create_los_measure',
    'Create a new LoS measure within a service area. Requires los_measures:write scope. Resolve service_area_id first via list_service_areas.',
    {
      service_area_id: z.string().guid().describe('Service area ID (required)'),
      name: z.string().min(1).max(500).describe('Measure name (required, unique per service area)'),
      category: z
        .enum([
          'quality',
          'reliability',
          'responsiveness',
          'safety',
          'sustainability',
          'cost_efficiency',
          'capacity',
          'scope',
        ])
        .describe('Measure category (required)'),
      type: z.enum(['community', 'technical']).describe('Measure type (required)'),
      data_source: z
        .enum([
          'manual',
          'custom_formula',
          'asset_condition_avg',
          'asset_condition_pct_above',
          'asset_condition_pct_below',
          'risk_score_avg',
          'risk_pct_critical',
          'wo_response_time_avg',
          'wo_completion_time_avg',
          'wo_backlog_count',
          'wo_overdue_count',
          'pm_compliance_rate',
          'compliance_score',
          'fci',
          'deferred_maintenance_ratio',
          'asset_past_useful_life_pct',
        ])
        .describe('Data source type (required). Use "manual" if values will be entered by hand.'),
      description: z.string().max(2000).optional().describe('Description'),
      community_statement: z
        .string()
        .max(2000)
        .optional()
        .describe('Community-facing statement (for community type measures)'),
      unit: z
        .string()
        .max(100)
        .optional()
        .describe('Unit of measurement (e.g., "%", "hours", "count")'),
      trend_direction: z
        .enum(['higher_is_better', 'lower_is_better', 'target_is_optimal'])
        .optional()
        .describe('Which direction is better'),
      target_value: z.number().optional().describe('Target value'),
      minimum_acceptable: z.number().optional().describe('Minimum acceptable value'),
      stretch_goal: z.number().optional().describe('Stretch goal value'),
      weight: z
        .number()
        .min(0)
        .optional()
        .describe('Weight for composite score calculation (default: 1.0)'),
      data_source_config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Data source configuration (JSONB). E.g., {"threshold": 3} for pct_above/below, {"days_back": 90} for WO metrics.'
        ),
      is_active: z.boolean().optional().describe('Whether the measure is active (default: true)'),
      sort_order: z.number().int().min(0).optional().describe('Sort order for display'),
    },
    async params => {
      try {
        const result = await client.create('los-measures', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_los_measure',
    'Update an existing LoS measure by ID. Requires los_measures:write scope.',
    {
      id: z.string().guid().describe('LoS measure ID'),
      name: z.string().min(1).max(500).optional().describe('Measure name'),
      category: z
        .enum([
          'quality',
          'reliability',
          'responsiveness',
          'safety',
          'sustainability',
          'cost_efficiency',
          'capacity',
          'scope',
        ])
        .optional()
        .describe('Measure category'),
      type: z.enum(['community', 'technical']).optional().describe('Measure type'),
      data_source: z
        .enum([
          'manual',
          'custom_formula',
          'asset_condition_avg',
          'asset_condition_pct_above',
          'asset_condition_pct_below',
          'risk_score_avg',
          'risk_pct_critical',
          'wo_response_time_avg',
          'wo_completion_time_avg',
          'wo_backlog_count',
          'wo_overdue_count',
          'pm_compliance_rate',
          'compliance_score',
          'fci',
          'deferred_maintenance_ratio',
          'asset_past_useful_life_pct',
        ])
        .optional()
        .describe('Data source type'),
      description: z.string().max(2000).optional().describe('Description'),
      community_statement: z.string().max(2000).optional().describe('Community-facing statement'),
      unit: z.string().max(100).optional().describe('Unit of measurement'),
      trend_direction: z
        .enum(['higher_is_better', 'lower_is_better', 'target_is_optimal'])
        .optional()
        .describe('Which direction is better'),
      target_value: z.number().optional().describe('Target value'),
      minimum_acceptable: z.number().optional().describe('Minimum acceptable value'),
      stretch_goal: z.number().optional().describe('Stretch goal value'),
      weight: z.number().min(0).optional().describe('Weight for composite score calculation'),
      data_source_config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Data source configuration (JSONB)'),
      is_active: z.boolean().optional().describe('Active status'),
      sort_order: z.number().int().min(0).optional().describe('Sort order'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('los-measures', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_los_measure',
    'Delete a LoS measure by ID. WARNING: This also deletes all associated measurements and targets history. Requires los_measures:write scope.',
    { id: z.string().guid().describe('LoS measure ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('los-measures', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Level of Service: Measurements (scope: los_measurements)
  // ============================================================

  server.tool(
    'create_los_measurement',
    'Record a new LoS measurement value. Requires los_measurements:write scope. Resolve los_measure_id first via list_los_measures.',
    {
      los_measure_id: z.string().guid().describe('LoS measure ID (required)'),
      period_type: z
        .enum(['monthly', 'quarterly', 'semi_annual', 'annual'])
        .describe('Period type (required)'),
      period_start: z
        .string()
        .describe('Period start date (ISO 8601, required, e.g., "2026-01-01")'),
      period_end: z.string().describe('Period end date (ISO 8601, required, e.g., "2026-03-31")'),
      actual_value: z.number().describe('Measured value (required)'),
      notes: z.string().max(2000).optional().describe('Notes or context for this measurement'),
      is_auto: z
        .boolean()
        .optional()
        .describe('Whether this is an auto-calculated value (default: false)'),
    },
    async params => {
      try {
        const result = await client.create('los-measurements', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_los_measurement',
    'Update an existing LoS measurement by ID. Requires los_measurements:write scope.',
    {
      id: z.string().guid().describe('LoS measurement ID'),
      actual_value: z.number().optional().describe('Measured value'),
      notes: z.string().max(2000).optional().describe('Notes or context'),
      period_type: z
        .enum(['monthly', 'quarterly', 'semi_annual', 'annual'])
        .optional()
        .describe('Period type'),
      period_start: z.string().optional().describe('Period start date (ISO 8601)'),
      period_end: z.string().optional().describe('Period end date (ISO 8601)'),
      is_auto: z.boolean().optional().describe('Whether this is auto-calculated'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('los-measurements', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_los_measurement',
    'Delete a LoS measurement by ID. Requires los_measurements:write scope.',
    { id: z.string().guid().describe('LoS measurement ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('los-measurements', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Level of Service: Proposed Targets (scope: los_proposed_targets)
  // ============================================================

  server.tool(
    'create_los_proposed_target',
    'Record the proposed level of service for a LoS measure in one future year (O. Reg. 588/17 s. 6(1)). One row per measure and year; a duplicate returns 409, so update the existing row instead. Use target_statement for a community measure and target_value for a technical one. Requires los_proposed_targets:write scope. Resolve los_measure_id first via list_los_measures.',
    {
      los_measure_id: z.string().guid().describe('LoS measure ID (required)'),
      year: z.number().int().min(2000).max(2200).describe('Target year, 2000-2200 (required)'),
      target_value: z
        .number()
        .optional()
        .describe("Proposed value for a technical measure, in the measure's own unit"),
      target_statement: z
        .string()
        .max(2000)
        .optional()
        .describe('Proposed level of service for a community measure, as a statement'),
    },
    async params => {
      try {
        const result = await client.create('los-proposed-targets', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_los_proposed_target',
    'Update an existing LoS proposed target by ID. Requires los_proposed_targets:write scope.',
    {
      id: z.string().guid().describe('LoS proposed target ID'),
      year: z.number().int().min(2000).max(2200).optional().describe('Target year, 2000-2200'),
      target_value: z
        .number()
        .optional()
        .describe("Proposed value for a technical measure, in the measure's own unit"),
      target_statement: z
        .string()
        .max(2000)
        .optional()
        .describe('Proposed level of service for a community measure, as a statement'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('los-proposed-targets', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_los_proposed_target',
    'Delete a LoS proposed target by ID. Requires los_proposed_targets:write scope.',
    { id: z.string().guid().describe('LoS proposed target ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('los-proposed-targets', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Level of Service: technical targets and criticality modifiers (scope: los_targets)
  // ============================================================

  const LOS_TARGET_METRICS = [
    'fci',
    'asset_condition_avg',
    'asset_past_useful_life_pct',
    'risk_score_avg',
  ] as const
  const INFRA_LOS_TARGET_METRICS = [
    'fci',
    'asset_condition_avg',
    'asset_past_useful_life_pct',
  ] as const
  const FACILITY_CRITICALITIES = ['critical', 'high', 'medium', 'low'] as const
  const LOS_BASE_TARGET_MAX = 100
  const CRITICALITY_MODIFIER_MIN = 0.1
  const CRITICALITY_MODIFIER_MAX = 1.9
  const BASE_TARGET_SCALES =
    'fci, asset_condition_avg and asset_past_useful_life_pct run 0-100; risk_score_avg runs 0-25'

  server.tool(
    'create_system_los_target',
    "Set the technical Level of Service target for one system and metric. One base target per system and metric, set once for the organization; a duplicate returns 409, so update the existing row instead. Each building is held to a version adjusted by its criticality: a lower-is-better target is multiplied by the tier's modifier, a higher-is-better one keeps its distance from a perfect score multiplied by it (condition 70 becomes 82 at a Critical facility, 58 at a Low one). Derived targets never leave the metric's scale. Direction is fixed by the metric and cannot be sent: asset_condition_avg is higher-is-better and uses the fixed 0-100 condition bands; fci, asset_past_useful_life_pct (both 0-100 percent) and risk_score_avg (0-25) are lower-is-better. Not money. Requires los_targets:write scope. Resolve system_id first via list_systems.",
    {
      system_id: z
        .string()
        .guid()
        .describe('System ID (required) - resolve first via list_systems'),
      metric: z.enum(LOS_TARGET_METRICS).describe('Metric the target tracks (required)'),
      base_target: z
        .number()
        .min(0)
        .max(LOS_BASE_TARGET_MAX)
        .describe(`Base target on the metric's scale (required): ${BASE_TARGET_SCALES}`),
      active: z.boolean().optional().describe('Whether the target is scored (default true)'),
    },
    async params => {
      try {
        const result = await client.create('system-los-targets', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_system_los_target',
    'Update a system LoS target by ID. base_target must sit on the scale of the metric in force (0-100, or 0-25 for risk_score_avg), so send a new base_target when changing to a metric with a smaller scale. Direction follows the metric automatically. Requires los_targets:write scope.',
    {
      id: z.string().guid().describe('System LoS target ID'),
      system_id: z
        .string()
        .guid()
        .optional()
        .describe('System ID - resolve first via list_systems'),
      metric: z.enum(LOS_TARGET_METRICS).optional().describe('Metric the target tracks'),
      base_target: z
        .number()
        .min(0)
        .max(LOS_BASE_TARGET_MAX)
        .optional()
        .describe(`Base target on the metric's scale: ${BASE_TARGET_SCALES}`),
      active: z.boolean().optional().describe('Whether the target is scored'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('system-los-targets', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_system_los_target',
    'Delete a system LoS target by ID. Buildings stop being scored on that system and metric; past status snapshots are kept. Requires los_targets:write scope.',
    { id: z.string().guid().describe('System LoS target ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('system-los-targets', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'create_infrastructure_los_target',
    "Set the technical Level of Service target for one infrastructure feature class and metric. One base target per feature class and metric, set once for the organization; a duplicate returns 409, so update the existing row instead. Each network of that class is held to a version adjusted by the network's criticality (unrated counts as medium): a lower-is-better target is multiplied by the tier's modifier, a higher-is-better one keeps its distance from a perfect score multiplied by it (condition 70 becomes 82 at a Critical network, 58 at a Low one). Derived targets never leave the metric's scale. All three metrics run 0-100: asset_condition_avg is higher-is-better and uses the fixed condition bands; fci and asset_past_useful_life_pct are percentages, lower-is-better. Average risk is not available for infrastructure. Not money. Requires los_targets:write scope, and the organization's plan must include both Level of Service and Infrastructure. Resolve feature_class first via list_infrastructure_feature_classes.",
    {
      feature_class: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,49}$/)
        .describe(
          'Feature class code (required) - must exist; resolve first via list_infrastructure_feature_classes'
        ),
      metric: z.enum(INFRA_LOS_TARGET_METRICS).describe('Metric the target tracks (required)'),
      base_target: z
        .number()
        .min(0)
        .max(LOS_BASE_TARGET_MAX)
        .describe('Base target, 0-100 (required)'),
      active: z.boolean().optional().describe('Whether the target is scored (default true)'),
    },
    async params => {
      try {
        const result = await client.create('infrastructure-los-targets', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_infrastructure_los_target',
    'Update an infrastructure LoS target by ID. base_target stays on 0-100. Requires los_targets:write scope.',
    {
      id: z.string().guid().describe('Infrastructure LoS target ID'),
      feature_class: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,49}$/)
        .optional()
        .describe('Feature class code - resolve first via list_infrastructure_feature_classes'),
      metric: z.enum(INFRA_LOS_TARGET_METRICS).optional().describe('Metric the target tracks'),
      base_target: z
        .number()
        .min(0)
        .max(LOS_BASE_TARGET_MAX)
        .optional()
        .describe('Base target, 0-100'),
      active: z.boolean().optional().describe('Whether the target is scored'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('infrastructure-los-targets', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_infrastructure_los_target',
    'Delete an infrastructure LoS target by ID. Networks of that class stop being scored on the metric; past status snapshots are kept. Requires los_targets:write scope.',
    { id: z.string().guid().describe('Infrastructure LoS target ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('infrastructure-los-targets', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'create_criticality_modifier',
    'Override the criticality modifier for one tier. Rows are overrides only: a tier with no row uses the built-in default (critical 0.6, high 0.8, medium 1.0, low 1.4). A modifier below 1 tightens every target held by facilities in that tier and one above 1 relaxes them. One override per tier; a duplicate returns 409, so call list_criticality_modifiers and update the existing row instead. Requires los_targets:write scope.',
    {
      criticality: z.enum(FACILITY_CRITICALITIES).describe('Criticality tier (required)'),
      modifier: z
        .number()
        .min(CRITICALITY_MODIFIER_MIN)
        .max(CRITICALITY_MODIFIER_MAX)
        .describe('Multiplier from 0.1 to 1.9 (required); below 1 tightens, above 1 relaxes'),
    },
    async params => {
      try {
        const result = await client.create('criticality-modifiers', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_criticality_modifier',
    'Update a criticality modifier override by ID. Below 1 tightens the targets of facilities in that tier, above 1 relaxes them. Requires los_targets:write scope.',
    {
      id: z.string().guid().describe('Criticality modifier ID'),
      criticality: z.enum(FACILITY_CRITICALITIES).optional().describe('Criticality tier'),
      modifier: z
        .number()
        .min(CRITICALITY_MODIFIER_MIN)
        .max(CRITICALITY_MODIFIER_MAX)
        .optional()
        .describe('Multiplier from 0.1 to 1.9; below 1 tightens, above 1 relaxes'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('criticality-modifiers', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_criticality_modifier',
    'Delete a criticality modifier override by ID, which restores the built-in default for that tier (critical 0.6, high 0.8, medium 1.0, low 1.4). Requires los_targets:write scope.',
    { id: z.string().guid().describe('Criticality modifier ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('criticality-modifiers', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Level of Service: consequences (scope: los_consequences)
  // ============================================================

  const LOS_CONSEQUENCE_SCOPE_TYPES = [
    'global',
    'criticality_tier',
    'system',
    'feature_class',
  ] as const
  const LOS_CONSEQUENCE_SEVERITIES = ['info', 'warning', 'critical'] as const
  const LOS_CONSEQUENCE_NOTIFY_ROLES = ['administrator', 'manager'] as const
  const SCOPE_REF_DESCRIPTION =
    'What the scope points at: null for global; critical, high, medium or low for criticality_tier; a system ID (resolve first via list_systems) for system; a feature class code (resolve first via list_infrastructure_feature_classes) for feature_class'

  server.tool(
    'create_los_consequence',
    "Record what a missed technical Level of Service target means, in the organization's own words. Advisory only: the statement is shown on the Status screen when a matching target is breached, and no notification is sent to notify_roles or to anyone else. When several match a breach the most specific scope wins (a specific system or feature class over a criticality tier over global). severity is a floor; the severity shown scales with the size of the gap and the facility's criticality. Requires los_consequences:write scope.",
    {
      scope_type: z
        .enum(LOS_CONSEQUENCE_SCOPE_TYPES)
        .describe('What the consequence applies to (required)'),
      scope_ref: z
        .string()
        .nullable()
        .optional()
        .describe(`${SCOPE_REF_DESCRIPTION}. Required unless scope_type is global`),
      metric: z
        .enum(LOS_TARGET_METRICS)
        .nullable()
        .optional()
        .describe('Limit to one metric; omit or null to match any metric'),
      statement: z.string().min(1).max(2000).describe('The consequence, as a statement (required)'),
      severity: z.enum(LOS_CONSEQUENCE_SEVERITIES).describe('Minimum severity shown (required)'),
      notify_roles: z
        .array(z.enum(LOS_CONSEQUENCE_NOTIFY_ROLES))
        .optional()
        .describe('Roles named as owning the consequence. Recorded only; nothing is sent'),
      active: z.boolean().optional().describe('Whether the consequence is shown (default true)'),
    },
    async params => {
      try {
        const result = await client.create('los-consequences', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_los_consequence',
    'Update a LoS consequence by ID. Changing scope_type to global clears scope_ref; changing it to anything else needs a scope_ref that fits the new type. Advisory only: no notification is sent. Requires los_consequences:write scope.',
    {
      id: z.string().guid().describe('LoS consequence ID'),
      scope_type: z
        .enum(LOS_CONSEQUENCE_SCOPE_TYPES)
        .optional()
        .describe('What the consequence applies to'),
      scope_ref: z.string().nullable().optional().describe(SCOPE_REF_DESCRIPTION),
      metric: z
        .enum(LOS_TARGET_METRICS)
        .nullable()
        .optional()
        .describe('Limit to one metric; null matches any metric'),
      statement: z.string().min(1).max(2000).optional().describe('The consequence, as a statement'),
      severity: z.enum(LOS_CONSEQUENCE_SEVERITIES).optional().describe('Minimum severity shown'),
      notify_roles: z
        .array(z.enum(LOS_CONSEQUENCE_NOTIFY_ROLES))
        .optional()
        .describe('Roles named as owning the consequence. Recorded only; nothing is sent'),
      active: z.boolean().optional().describe('Whether the consequence is shown'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('los-consequences', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_los_consequence',
    'Delete a LoS consequence by ID. Requires los_consequences:write scope.',
    { id: z.string().guid().describe('LoS consequence ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('los-consequences', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Floorplans (enterprise++ feature)
  // ============================================================

  const FLOORPLAN_STATUSES = ['pending', 'detecting', 'ready', 'failed'] as const
  const REGION_SOURCES = ['manual', 'ai'] as const
  const polygonSchema = z
    .array(z.array(z.number().min(0).max(1)).min(2).max(2))
    .min(3)
    .describe(
      'Polygon outline as an array of [x, y] points in normalized 0-1 coordinates (origin top-left). At least 3 points.'
    )

  server.tool(
    'create_floorplan',
    'Create a floorplan row. Provide EXACTLY ONE of building_id (per-building floor) or site_id (site-level / campus plan). Typically the web app calls this per page of an uploaded PDF; MCP clients rarely need to call this directly since they do not upload the PDF itself. Requires floorplans:write scope.',
    {
      building_id: z
        .string()
        .guid()
        .optional()
        .describe('Building this floor belongs to (omit if site-scoped)'),
      site_id: z
        .string()
        .guid()
        .optional()
        .describe(
          'Site this plan belongs to (use for site-level / campus plans; omit if building-scoped)'
        ),
      floor_label: z
        .string()
        .max(200)
        .describe('Human-readable label (e.g. "Ground Floor", "Mezzanine", "Site Plan")'),
      floor_order: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Sort order within the scope (lowest first)'),
      pdf_storage_path: z.string().max(1000).describe('Supabase Storage path to the PDF file'),
      pdf_filename: z.string().max(500).describe('Original filename for display'),
      page_number: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('1-indexed page number within the PDF'),
      page_width_pt: z
        .number()
        .min(0)
        .optional()
        .describe('Page width in PDF points (discovered client-side)'),
      page_height_pt: z.number().min(0).optional().describe('Page height in PDF points'),
      status: z.enum(FLOORPLAN_STATUSES).optional().describe('Detection status (default: pending)'),
    },
    async params => {
      try {
        const hasBuilding = !!params.building_id
        const hasSite = !!params.site_id
        if (hasBuilding === hasSite) {
          return formatError(
            new Error('create_floorplan: provide exactly one of building_id or site_id')
          )
        }
        const result = await client.create('floorplans', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_floorplan',
    'Update floorplan metadata (rename floor, reorder, set status). Requires floorplans:write scope.',
    {
      id: z.string().guid().describe('Floorplan ID'),
      floor_label: z.string().max(200).optional().describe('New floor label'),
      floor_order: z.number().int().min(0).optional().describe('New sort order'),
      status: z.enum(FLOORPLAN_STATUSES).optional().describe('Detection status'),
      detection_error: z.string().max(2000).optional().describe('Error message if status=failed'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('floorplans', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_floorplan',
    'Delete a floorplan. WARNING: cascades to all regions and asset placements on this floor. Does NOT delete the underlying PDF file from storage (do that separately if no other floors reference it). Requires floorplans:write scope.',
    { id: z.string().guid().describe('Floorplan ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('floorplans', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'create_floorplan_region',
    'Create a region (labeled room or zone) on a floorplan. Polygon coordinates are normalized 0-1 with origin top-left. Optionally link the region to an existing Location via location_id. Requires floorplan_regions:write scope.',
    {
      floorplan_id: z.string().guid().describe('Floorplan this region belongs to'),
      label: z.string().max(500).describe('Region label (e.g. "Boiler Room 2B")'),
      polygon: polygonSchema,
      location_id: z
        .string()
        .guid()
        .optional()
        .describe('Linked Location ID (resolved via list_locations)'),
      source: z
        .enum(REGION_SOURCES)
        .optional()
        .describe('"manual" (default) or "ai" for AI-detected'),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('AI confidence score (0-1), only set when source=ai'),
      reviewed: z
        .boolean()
        .optional()
        .describe(
          'True if an admin has reviewed this region (default: true for manual, false for ai)'
        ),
    },
    async params => {
      try {
        const result = await client.create('floorplan-regions', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_floorplan_region',
    'Update a floorplan region - rename, reshape polygon, link to a Location, or mark as reviewed. Requires floorplan_regions:write scope.',
    {
      id: z.string().guid().describe('Floorplan region ID'),
      label: z.string().max(500).optional().describe('New label'),
      polygon: polygonSchema.optional(),
      location_id: z
        .string()
        .guid()
        .optional()
        .describe('Linked Location ID (set to null to unlink)'),
      confidence: z.number().min(0).max(1).optional(),
      reviewed: z.boolean().optional().describe('Mark region as reviewed by admin'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('floorplan-regions', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_floorplan_region',
    'Delete a region. Asset placements that referenced this region will have region_id set to null but remain on the floorplan. Requires floorplan_regions:write scope.',
    { id: z.string().guid().describe('Floorplan region ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('floorplan-regions', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'create_asset_placement',
    'Place an asset on a floorplan at the given (x, y) coordinate (normalized 0-1, origin top-left). UPSERTS by asset_id - an asset can have at most ONE placement globally, so calling this again just moves the pin. Use bulk_create with resource="asset-placements" to place many assets at once. Requires asset_placements:write scope.',
    {
      asset_id: z.string().guid().describe('Asset to place (resolve via list_assets)'),
      floorplan_id: z.string().guid().describe('Target floorplan (resolve via list_floorplans)'),
      x: z.number().min(0).max(1).describe('Normalized x coordinate (0=left, 1=right)'),
      y: z.number().min(0).max(1).describe('Normalized y coordinate (0=top, 1=bottom)'),
      region_id: z
        .string()
        .guid()
        .optional()
        .describe('Optional region the pin sits inside (usually auto-inferred)'),
      source: z
        .enum(REGION_SOURCES)
        .optional()
        .describe('"manual" (default) or "ai" for AI-placed'),
    },
    async params => {
      try {
        const result = await client.create('asset-placements', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset_placement',
    'Move an asset placement to new coordinates or a different floorplan. Requires asset_placements:write scope.',
    {
      id: z.string().guid().describe('Asset placement ID'),
      x: z.number().min(0).max(1).optional().describe('New x coordinate'),
      y: z.number().min(0).max(1).optional().describe('New y coordinate'),
      region_id: z.string().guid().optional().describe('New region (set to null to clear)'),
      floorplan_id: z.string().guid().optional().describe('Move to a different floorplan'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('asset-placements', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset_placement',
    'Remove an asset placement. The asset itself is not affected - only the pin on the floorplan is removed. Requires asset_placements:write scope.',
    { id: z.string().guid().describe('Asset placement ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('asset-placements', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Bulk operations
  // ============================================================

  const BULK_RESOURCES = [
    'assets',
    'work-orders',
    'work-requests',
    'vendors',
    'sites',
    'buildings',
    'locations',
    'systems',
    'system-groups',
    'system-classes',
    'pm-schedules',
    'pm-templates',
    'form-templates',
    'form-template-items',
    'form-responses',
    'projects',
    'contracts',
    'invoices',
    'purchase-orders',
    'expenses',
    'budgets',
    'asset-types',
    'asset-type-groups',
    'asset-statuses',
    'work-categories',
    'manufacturers',
    'building-types',
    'location-types',
    'cost-categories',
    'compliance',
    'compliance-records',
    'asset-comments',
    'asset-costs',
    'asset-replacement-plans',
    'work-order-comments',
    'project-tasks',
    'project-milestones',
    'project-phases',
    'project-budget-items',
    'project-time-entries',
    'project-comments',
    'project-team-members',
    'project-task-dependencies',
    'project-updates',
    'project-cost-snapshots',
    'project-locations',
    'project-sites',
    'project-buildings',
    'project-systems',
    'project-system-classes',
    'project-system-groups',
    'project-assets',
    'project-risks',
    'parts',
    'part-categories',
    'custom-field-definitions',
    'custom-field-values',
    'vendor-site-assignments',
    'contract-sites',
    'asset-documents',
    'attachments',
    'project-documents',
    'contract-documents',
    'service-areas',
    'los-measures',
    'los-measurements',
    'los-proposed-targets',
    'floorplans',
    'floorplan-regions',
    'asset-placements',
    'infrastructure-assets',
  ] as const

  server.tool(
    'bulk_create',
    'Create multiple records of a resource type in one API call (max 100). Each item is processed independently - one failure does not affect others. Returns per-item results. Requires {resource}:write scope. Counts as 1 request for rate limiting.',
    {
      resource: z.enum(BULK_RESOURCES).describe('Resource type (e.g. "assets", "work-orders")'),
      items: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .max(100)
        .describe(
          'Array of objects to create (max 100). Each object uses the same fields as the single-create endpoint for that resource.'
        ),
    },
    async ({ resource, items }) => {
      try {
        const result = await client.bulkCreate(resource, items as Record<string, unknown>[])
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Asset Statuses (scope: asset_statuses)
  // ============================================================

  server.tool(
    'create_asset_status',
    'Create a new asset status (lifecycle state for assets). Requires asset_statuses:write scope.',
    {
      name: z.string().max(500).describe('Status name (required)'),
      description: z.string().optional().describe('Description'),
      module: WORKSPACE.optional().describe(
        'Workspace the status is offered in: facilities (assets), infrastructure (features), or shared (both). Defaults to shared.'
      ),
    },
    async params => {
      try {
        const result = await client.create('asset-statuses', workspaceBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset_status',
    'Update an existing asset status by ID. Requires asset_statuses:write scope.',
    {
      id: z.string().guid().describe('Asset status ID'),
      name: z.string().max(500).optional().describe('Status name'),
      description: z.string().optional().describe('Description'),
      module: WORKSPACE.optional().describe(
        'Move the status to a workspace: facilities, infrastructure, or shared (both).'
      ),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('asset-statuses', id, workspaceBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset_status',
    'Delete an asset status by ID. Requires asset_statuses:write scope.',
    { id: z.string().guid().describe('Asset status ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('asset-statuses', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Compliance Items (scope: compliance)
  // ============================================================

  server.tool(
    'create_compliance_item',
    'Create a new compliance item (regulatory requirement). Requires compliance:write scope.',
    {
      name: z.string().max(500).describe('Compliance item name (required)'),
      description: z.string().optional().describe('Description'),
      regulation_reference: z.string().max(500).optional().describe('Regulation or code reference'),
      compliance_period_months: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Compliance period in months'),
      status: z.enum(['active', 'archived']).optional().describe('Status'),
      system_id: z.string().guid().optional().describe('Associated system ID'),
    },
    async params => {
      try {
        const result = await client.create('compliance', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_compliance_item',
    'Update an existing compliance item by ID. Requires compliance:write scope.',
    {
      id: z.string().guid().describe('Compliance item ID'),
      name: z.string().max(500).optional().describe('Compliance item name'),
      description: z.string().optional().describe('Description'),
      regulation_reference: z.string().max(500).optional().describe('Regulation or code reference'),
      compliance_period_months: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Compliance period in months'),
      status: z.enum(['active', 'archived']).optional().describe('Status'),
      system_id: z.string().guid().optional().describe('Associated system ID'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('compliance', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_compliance_item',
    'Delete a compliance item by ID. Requires compliance:write scope.',
    { id: z.string().guid().describe('Compliance item ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('compliance', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Compliance Records (scope: compliance_records)
  // ============================================================

  server.tool(
    'create_compliance_record',
    'Create a new compliance record (audit trail entry). Requires compliance_records:write scope.',
    {
      compliance_item_id: z.string().guid().describe('Compliance item ID (required)'),
      pm_schedule_id: z.string().guid().describe('PM schedule ID (required)'),
      work_order_id: z.string().guid().describe('Work order ID (required)'),
      completed_at: z.string().describe('Completion date-time (ISO 8601, required)'),
      completed_by: z.string().max(200).optional().describe('User ID who completed'),
      required_frequency_days: z
        .number()
        .int()
        .min(1)
        .describe('Required frequency in days (required)'),
      days_since_last_completion: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Days since last completion'),
    },
    async params => {
      try {
        const result = await client.create('compliance-records', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_compliance_record',
    'Update an existing compliance record by ID. Requires compliance_records:write scope.',
    {
      id: z.string().guid().describe('Compliance record ID'),
      completed_at: z.string().optional().describe('Completion date-time (ISO 8601)'),
      completed_by: z.string().max(200).optional().describe('User ID who completed'),
      required_frequency_days: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Required frequency in days'),
      days_since_last_completion: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Days since last completion'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('compliance-records', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_compliance_record',
    'Delete a compliance record by ID. Requires compliance_records:write scope.',
    { id: z.string().guid().describe('Compliance record ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('compliance-records', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'create_compliance_pm_schedule',
    'Link a PM schedule to a compliance item, so completing the schedule keeps the item compliant. Requires compliance:write scope. Required: compliance_item_id, pm_schedule_id, required_frequency_days. Resolve both ids first with list_compliance_items and list_pm_schedules.',
    {
      compliance_item_id: z.string().guid().describe('Compliance item ID (required)'),
      pm_schedule_id: z.string().guid().describe('PM schedule ID (required)'),
      required_frequency_days: z
        .number()
        .int()
        .min(1)
        .describe(
          'How often, in days, the schedule must be completed for the item to stay compliant (required), e.g. 365 for annual'
        ),
      weight: z
        .number()
        .positive()
        .optional()
        .describe('Relative weight of this schedule in the item score. Default 1.'),
    },
    async params => {
      try {
        const result = await client.create('compliance-pm-schedules', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_compliance_pm_schedule',
    'Change the required frequency or weight of a compliance item to PM schedule link. Requires compliance:write scope. To point a link at a different item or schedule, delete it and create a new one.',
    {
      id: z.string().guid().describe('Link ID - resolve via list_compliance_pm_schedules'),
      required_frequency_days: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Required frequency in days'),
      weight: z.number().positive().optional().describe('Relative weight'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('compliance-pm-schedules', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_compliance_pm_schedule',
    'Unlink a PM schedule from a compliance item. The schedule and the item both stay. Requires compliance:write scope.',
    { id: z.string().guid().describe('Link ID - resolve via list_compliance_pm_schedules') },
    async ({ id }) => {
      try {
        const result = await client.remove('compliance-pm-schedules', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Infrastructure Feature Classes (scope: infrastructure_feature_classes)
  // ============================================================

  const INFRA_ASSET_CLASS_CATEGORIES = [
    'transportation',
    'water',
    'wastewater',
    'stormwater',
    'structures',
    'electrical',
    'telecom',
    'gas',
    'roadside',
    'other',
  ] as const

  const featureClassCode = z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,49}$/)
    .describe('Asset class code (lowercase snake_case, 1-50 chars)')

  server.tool(
    'create_infrastructure_feature_class',
    'Create a tenant-defined infrastructure feature class. Builtin classes are managed by AssetLab and cannot be created via API (is_builtin is always forced to false). Requires infrastructure_feature_classes:write scope.',
    {
      code: featureClassCode,
      label: z.string().max(200).describe('Display name (required)'),
      category: z
        .enum(INFRA_ASSET_CLASS_CATEGORIES)
        .describe(
          'Category - municipal service family (transportation, water, wastewater, stormwater, structures, electrical, telecom, gas, roadside, other)'
        ),
      icon: z.string().max(50).optional().describe('Icon name'),
      color_hex: z.string().max(9).optional().describe('Display colour as hex, e.g. #3B82F6'),
      sort_order: z.number().int().optional().describe('Sort order'),
    },
    async params => {
      try {
        const result = await client.create('infrastructure-feature-classes', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_infrastructure_feature_class',
    'Update a tenant-defined infrastructure feature class (addressed by code). The `code`, `category`, and `is_builtin` fields are immutable; attempts to change them on a builtin class return 409. Requires infrastructure_feature_classes:write scope.',
    {
      code: featureClassCode,
      label: z.string().max(200).optional().describe('Display name'),
      icon: z.string().max(50).optional().describe('Icon name'),
      color_hex: z.string().max(9).optional().describe('Display colour as hex, e.g. #3B82F6'),
      sort_order: z.number().int().optional().describe('Sort order'),
    },
    async ({ code, ...rest }) => {
      try {
        const result = await client.update('infrastructure-feature-classes', code, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_infrastructure_feature_class',
    'Delete a tenant-defined infrastructure feature class by code. Builtin classes cannot be deleted. Classes referenced by any infrastructure network are protected by FK and cannot be deleted until those networks are reassigned. Requires infrastructure_feature_classes:write scope.',
    { code: featureClassCode },
    async ({ code }) => {
      try {
        const result = await client.remove('infrastructure-feature-classes', code)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Infrastructure Lifecycle Events (scope: infrastructure_lifecycle_events)
  // ============================================================

  const lifecycleEventScope = {
    feature_class: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,49}$/)
      .optional()
      .describe(
        'Feature class code the strategy scope applies to (omit for a material-wide scope; at least one of feature_class/material is required)'
      ),
    material: z
      .string()
      .max(200)
      .optional()
      .describe('Material the scope applies to, exactly as features carry it (e.g. "PVC")'),
    diameter_min_mm: z
      .number()
      .positive()
      .optional()
      .describe('Lower bound of a diameter band (requires material); bands ladder like rates'),
  }

  const lifecycleEventFields = {
    event_class: z
      .enum(['preventive', 'rehabilitation'])
      .describe('Event type - preventative maintenance or rehabilitation'),
    trigger_condition_max: z
      .number()
      .int()
      .min(1)
      .max(99)
      .describe(
        'Upper bound of the trigger window - the event fires when projected condition falls to this'
      ),
    trigger_condition_min: z
      .number()
      .int()
      .min(0)
      .max(98)
      .optional()
      .describe(
        'Lower bound of the trigger window (default 0); a feature already below it has missed the event'
      ),
    impact_method: z
      .enum(['add_years', 'reset_condition'])
      .describe('Effect: add years of life, or reset condition to a value'),
    impact_add_years: z
      .number()
      .positive()
      .max(100)
      .optional()
      .describe('Years added (required when impact_method is add_years)'),
    impact_reset_to: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Condition after the event (required when impact_method is reset_condition)'),
    cost_method: z
      .enum(['per_unit', 'fixed'])
      .optional()
      .describe(
        "Costing: per unit (uses the feature's measured quantity and unit) or a fixed amount (default per_unit)"
      ),
    unit_cost: z
      .number()
      .min(0)
      .optional()
      .describe('Cost per unit (current dollars, never indexed)'),
    fixed_cost: z.number().min(0).optional().describe('Fixed cost (current dollars)'),
    cost_source: z
      .string()
      .max(200)
      .optional()
      .describe('Provenance of the cost ("Engineering 2026", a tender reference)'),
    max_applications: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("How many times the event may fire over a feature's life (default 1)"),
    min_years_between: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Minimum years between firings of a recurring event (default 1)'),
    sort_order: z.number().int().min(0).optional().describe('Evaluation order within the strategy'),
    work_generation: z
      .enum(['none', 'work_order', 'project'])
      .optional()
      .describe(
        'What a due application of this event becomes when created from the interventions list: none (plan only, default), work_order, or project. Nothing is created on a schedule.'
      ),
    work_generation_category_id: z
      .string()
      .guid()
      .optional()
      .describe(
        'Work category for generated work orders - resolve with list_work_categories. Ignored unless work_generation is work_order.'
      ),
    work_generation_priority: z
      .enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
      .optional()
      .describe(
        'Priority for generated work orders. Ignored unless work_generation is work_order.'
      ),
  }

  server.tool(
    'create_infrastructure_lifecycle_event',
    'Create a lifecycle strategy event. Events attach to a SCOPE (feature_class code, material, optional diameter band) - never to individual features; every feature resolves the most specific matching scope, like replacement rates. Replacement is NOT an event (it is priced by the rates and scheduled by the renewal forecast) - model the interventions BEFORE replacement: crack sealing, relining, resurfacing. List existing events first to reuse a scope. Requires infrastructure_lifecycle_events:write scope.',
    {
      name: z.string().max(200).describe('Event name (required, e.g. "Crack Sealing")'),
      ...lifecycleEventScope,
      ...lifecycleEventFields,
    },
    async params => {
      try {
        const result = await client.create('infrastructure-lifecycle-events', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_infrastructure_lifecycle_event',
    'Update a lifecycle strategy event by ID. Editing re-confirms the cost (cost_reviewed_on is server-set). Set is_active false to disable an event without deleting it - projections recompute immediately. Requires infrastructure_lifecycle_events:write scope.',
    {
      id: z.string().guid().describe('Lifecycle event ID'),
      name: z.string().max(200).optional().describe('Event name'),
      is_active: z.boolean().optional().describe('Disable/enable the event'),
      event_class: lifecycleEventFields.event_class.optional(),
      trigger_condition_max: lifecycleEventFields.trigger_condition_max.optional(),
      trigger_condition_min: lifecycleEventFields.trigger_condition_min,
      impact_method: lifecycleEventFields.impact_method.optional(),
      impact_add_years: lifecycleEventFields.impact_add_years,
      impact_reset_to: lifecycleEventFields.impact_reset_to,
      cost_method: lifecycleEventFields.cost_method,
      unit_cost: lifecycleEventFields.unit_cost,
      fixed_cost: lifecycleEventFields.fixed_cost,
      cost_source: lifecycleEventFields.cost_source,
      max_applications: lifecycleEventFields.max_applications,
      min_years_between: lifecycleEventFields.min_years_between,
      sort_order: lifecycleEventFields.sort_order,
      work_generation: lifecycleEventFields.work_generation,
      work_generation_category_id: lifecycleEventFields.work_generation_category_id,
      work_generation_priority: lifecycleEventFields.work_generation_priority,
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('infrastructure-lifecycle-events', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_infrastructure_lifecycle_event',
    'Delete a lifecycle strategy event by ID. Projections recompute immediately; consider update with is_active=false to disable instead. Requires infrastructure_lifecycle_events:write scope.',
    { id: z.string().guid().describe('Lifecycle event ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('infrastructure-lifecycle-events', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Infrastructure Networks (scope: infrastructure_networks)
  // ============================================================

  const NETWORK_CRITICALITY = z
    .enum(FACILITY_CRITICALITIES)
    .describe(
      "How strictly the network is held to its feature class's Level of Service targets: critical, high, medium or low. Unset is treated as medium; send null on update to clear it"
    )

  server.tool(
    'create_infrastructure_network',
    'Create an infrastructure network - a named grouping of features bound to one feature class. Requires infrastructure_networks:write scope.',
    {
      name: z.string().max(200).describe('Network name (required)'),
      feature_class: featureClassCode.describe(
        'Asset class code (must exist; resolve via list_infrastructure_feature_classes)'
      ),
      description: z.string().optional().describe('Description'),
      color_scheme: z.string().max(50).optional().describe('Display color scheme'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Free-form JSON metadata'),
      criticality: NETWORK_CRITICALITY.optional(),
    },
    async params => {
      try {
        const result = await client.create('infrastructure-networks', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_infrastructure_network',
    'Update an existing infrastructure network by ID. Requires infrastructure_networks:write scope.',
    {
      id: z.string().guid().describe('Infrastructure network ID'),
      name: z.string().max(200).optional().describe('Network name'),
      feature_class: featureClassCode.optional().describe('Asset class code'),
      description: z.string().optional().describe('Description'),
      color_scheme: z.string().max(50).optional().describe('Display color scheme'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Free-form JSON metadata'),
      // zod 4 keeps a description on the inner schema under .nullable(); restate it on the property.
      criticality: NETWORK_CRITICALITY.nullable()
        .optional()
        .describe(NETWORK_CRITICALITY.description ?? ''),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('infrastructure-networks', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_infrastructure_network',
    'Delete an infrastructure network by ID. Cascades to all features in the network - confirm with the user before deleting. Requires infrastructure_networks:write scope.',
    { id: z.string().guid().describe('Infrastructure network ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('infrastructure-networks', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Infrastructure Assets / Features (scope: infrastructure_assets)
  // ============================================================

  const pointGeometry = z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number(), z.number()]),
  })
  const lineStringGeometry = z.object({
    type: z.literal('LineString'),
    coordinates: z.array(z.tuple([z.number(), z.number()])).min(2),
  })
  const featureGeometry = z.union([pointGeometry, lineStringGeometry])

  const FEATURE_TYPES = ['segment', 'node'] as const
  const FLOW_DIRECTIONS = ['with_geometry', 'against_geometry'] as const
  const POSITIONAL_ACCURACY = ['survey_grade', 'mapping_grade', 'sketch', 'unknown'] as const

  server.tool(
    'create_infrastructure_asset',
    'Create an infrastructure asset (feature - segment or node). Geometry must be GeoJSON Point (for nodes) or LineString (for segments) in EPSG:4326; coordinates are [longitude, latitude]. `length_m`, `slope_pct`, and `risk_score` are computed server-side. Requires infrastructure_assets:write scope.',
    {
      network_id: z.string().guid().describe('Infrastructure network ID (required)'),
      feature_type: z.enum(FEATURE_TYPES).describe('"segment" (LineString) or "node" (Point)'),
      geometry: featureGeometry.describe(
        'GeoJSON geometry - Point for nodes, LineString for segments'
      ),
      name: z.string().max(500).optional().describe('Feature name'),
      feature_code: z
        .string()
        .max(100)
        .optional()
        .describe(
          'Feature ID - human-readable asset identifier, unique per tenant (typically the source GIS asset id)'
        ),
      description: z.string().optional().describe('Description'),
      external_ids: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Free-form external ID map'),
      from_street: z.string().max(200).optional().describe('From street (segments)'),
      to_street: z.string().max(200).optional().describe('To street (segments)'),
      image_url: z.string().optional().describe('Image URL'),
      qr_code: z.string().max(200).optional().describe('QR code'),
      from_feature_id: z.string().guid().optional().describe('From-node feature ID (segments)'),
      to_feature_id: z.string().guid().optional().describe('To-node feature ID (segments)'),
      flow_direction: z.enum(FLOW_DIRECTIONS).optional().describe('Flow direction'),
      asset_type_id: z.string().guid().optional().describe('Asset type ID'),
      manufacturer_id: z.string().guid().optional().describe('Manufacturer ID'),
      system_class_id: z.string().guid().optional().describe('System class ID'),
      system_group_id: z.string().guid().optional().describe('System group ID'),
      system_id: z.string().guid().optional().describe('System ID'),
      model: z.string().max(200).optional().describe('Model'),
      serial_number: z.string().max(200).optional().describe('Serial number'),
      site_id: z.string().guid().optional().describe('Site ID'),
      building_id: z.string().guid().optional().describe('Building ID'),
      location_id: z.string().guid().optional().describe('Location ID'),
      status_id: z.string().optional().describe('Asset status ID'),
      condition_score: z.number().min(0).max(100).optional().describe('Condition score (0-100)'),
      last_maintenance_date: z.string().optional().describe('Last maintenance date (YYYY-MM-DD)'),
      risk_factor: z.string().optional().describe('Risk factor: CRITICAL, HIGH, MEDIUM, LOW'),
      consequence_of_failure_score: z.number().min(0).max(100).optional(),
      likelihood_of_failure_score: z.number().min(0).max(100).optional(),
      safety_impact: z.string().optional().describe('LOW, MEDIUM, HIGH, CRITICAL'),
      service_impact: z.string().optional().describe('LOW, MEDIUM, HIGH, CRITICAL'),
      environmental_impact: z.string().optional().describe('LOW, MEDIUM, HIGH, CRITICAL'),
      financial_impact: z.string().optional().describe('LOW, MEDIUM, HIGH, CRITICAL'),
      regulatory_impact: z.string().optional().describe('LOW, MEDIUM, HIGH, CRITICAL'),
      reputation_impact: z.string().optional().describe('LOW, MEDIUM, HIGH, CRITICAL'),
      purchase_cost: z.number().min(0).optional().describe('Purchase cost'),
      purchase_date: z.string().optional().describe('Purchase date (YYYY-MM-DD)'),
      install_date: z.string().optional().describe('Install date (YYYY-MM-DD)'),
      expected_lifetime_years: z.number().min(0).optional().describe('Expected lifetime (years)'),
      salvage_value: z.number().min(0).optional().describe('Salvage value'),
      salvage_value_percentage: z.number().min(0).max(100).optional(),
      quantity: z.number().min(0).optional().describe('Quantity'),
      unit_of_measure: z.string().max(50).optional().describe('Unit of measure'),
      unit_replacement_value: z.number().min(0).optional().describe('Unit replacement value'),
      purchase_cost_calculation_method: z
        .enum(['manual', 'calculated_sqft', 'calculated_unit'])
        .optional()
        .describe('Cost calc method'),
      material: z.string().max(200).optional().describe('Material'),
      diameter_mm: z.number().min(0).optional().describe('Diameter (mm)'),
      width_m: z.number().min(0).optional().describe('Width (m)'),
      lanes: z.number().int().min(0).optional().describe('Lane count'),
      road_class: z
        .number()
        .int()
        .min(1)
        .max(6)
        .nullable()
        .optional()
        .describe('O. Reg. 239/02 road class 1-6 (1-2 arterial, 3-4 collector, 5-6 local)'),
      depth_m: z.number().min(0).optional().describe('Depth (m)'),
      from_invert_m: z.number().optional().describe('From-invert elevation (m)'),
      to_invert_m: z.number().optional().describe('To-invert elevation (m)'),
      positional_accuracy_class: z
        .enum(POSITIONAL_ACCURACY)
        .optional()
        .describe('Positional accuracy class'),
      data_source: z.string().max(200).optional().describe('Data source'),
    },
    async params => {
      try {
        const result = await client.create('infrastructure-assets', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_infrastructure_asset',
    'Update an existing infrastructure asset (feature) by ID. To change geometry, provide a new GeoJSON Point/LineString matching the existing feature_type. Computed columns (length_m, slope_pct, risk_score) cannot be set. Requires infrastructure_assets:write scope.',
    {
      id: z.string().guid().describe('Infrastructure asset ID'),
      geometry: featureGeometry.optional().describe('Replacement GeoJSON geometry'),
      name: z.string().max(500).optional(),
      feature_code: z.string().max(100).optional(),
      description: z.string().optional(),
      external_ids: z.record(z.string(), z.unknown()).optional(),
      from_street: z.string().max(200).optional(),
      to_street: z.string().max(200).optional(),
      image_url: z.string().optional(),
      qr_code: z.string().max(200).optional(),
      from_feature_id: z.string().guid().optional(),
      to_feature_id: z.string().guid().optional(),
      flow_direction: z.enum(FLOW_DIRECTIONS).optional(),
      asset_type_id: z.string().guid().optional(),
      manufacturer_id: z.string().guid().optional(),
      system_class_id: z.string().guid().optional(),
      system_group_id: z.string().guid().optional(),
      system_id: z.string().guid().optional(),
      model: z.string().max(200).optional(),
      serial_number: z.string().max(200).optional(),
      site_id: z.string().guid().optional(),
      building_id: z.string().guid().optional(),
      location_id: z.string().guid().optional(),
      status_id: z.string().optional(),
      condition_score: z.number().min(0).max(100).optional(),
      last_maintenance_date: z.string().optional(),
      risk_factor: z.string().optional(),
      consequence_of_failure_score: z.number().min(0).max(100).optional(),
      likelihood_of_failure_score: z.number().min(0).max(100).optional(),
      safety_impact: z.string().optional(),
      service_impact: z.string().optional(),
      environmental_impact: z.string().optional(),
      financial_impact: z.string().optional(),
      regulatory_impact: z.string().optional(),
      reputation_impact: z.string().optional(),
      purchase_cost: z.number().min(0).optional(),
      purchase_date: z.string().optional(),
      install_date: z.string().optional(),
      expected_lifetime_years: z.number().min(0).optional(),
      salvage_value: z.number().min(0).optional(),
      salvage_value_percentage: z.number().min(0).max(100).optional(),
      quantity: z.number().min(0).optional(),
      unit_of_measure: z.string().max(50).optional(),
      unit_replacement_value: z.number().min(0).optional(),
      purchase_cost_calculation_method: z
        .enum(['manual', 'calculated_sqft', 'calculated_unit'])
        .optional(),
      material: z.string().max(200).optional(),
      diameter_mm: z.number().min(0).optional(),
      width_m: z.number().min(0).optional(),
      lanes: z.number().int().min(0).optional(),
      road_class: z
        .number()
        .int()
        .min(1)
        .max(6)
        .nullable()
        .optional()
        .describe('O. Reg. 239/02 road class 1-6 (1-2 arterial, 3-4 collector, 5-6 local)'),
      depth_m: z.number().min(0).optional(),
      from_invert_m: z.number().optional(),
      to_invert_m: z.number().optional(),
      positional_accuracy_class: z.enum(POSITIONAL_ACCURACY).optional(),
      data_source: z.string().max(200).optional(),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('infrastructure-assets', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_infrastructure_asset',
    'Soft-delete an infrastructure asset (feature) by ID (sets deleted_at). Requires infrastructure_assets:write scope.',
    { id: z.string().guid().describe('Infrastructure asset ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('infrastructure-assets', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Infrastructure Asset Inspections (scope: infrastructure_asset_inspections)
  // ============================================================

  server.tool(
    'create_infrastructure_asset_inspection',
    'Record an inspection against an infrastructure feature. Requires infrastructure_asset_inspections:write scope.',
    {
      feature_id: z.string().guid().describe('Infrastructure asset (feature) ID (required)'),
      inspection_date: z.string().describe('Inspection date (YYYY-MM-DD, required)'),
      inspector_id: z.string().optional().describe('Inspector user ID'),
      method: z.string().max(100).optional().describe('Inspection method (e.g. CCTV, visual)'),
      condition_score: z.number().min(0).max(100).optional().describe('Condition score (0-100)'),
      defects: z.record(z.string(), z.unknown()).optional().describe('Defect observations (JSON)'),
      notes: z.string().optional().describe('Free-form notes'),
      attachments: z.array(z.string()).optional().describe('Attachment URLs/paths'),
    },
    async params => {
      try {
        const result = await client.create('infrastructure-asset-inspections', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_infrastructure_asset_inspection',
    'Update an existing infrastructure asset inspection by ID. Requires infrastructure_asset_inspections:write scope.',
    {
      id: z.string().guid().describe('Inspection ID'),
      inspection_date: z.string().optional().describe('Inspection date (YYYY-MM-DD)'),
      inspector_id: z.string().optional().describe('Inspector user ID'),
      method: z.string().max(100).optional().describe('Inspection method'),
      condition_score: z.number().min(0).max(100).optional().describe('Condition score'),
      defects: z.record(z.string(), z.unknown()).optional().describe('Defect observations'),
      notes: z.string().optional().describe('Notes'),
      attachments: z.array(z.string()).optional().describe('Attachment URLs/paths'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('infrastructure-asset-inspections', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_infrastructure_asset_inspection',
    'Soft-delete an infrastructure asset inspection by ID. Requires infrastructure_asset_inspections:write scope.',
    { id: z.string().guid().describe('Inspection ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('infrastructure-asset-inspections', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Asset Lifecycle Events (scope: asset_lifecycle_events)
  // ============================================================

  const assetLifecycleEventFields = {
    event_class: z
      .enum(['preventive', 'rehabilitation'])
      .describe('Event type - preventative maintenance or rehabilitation'),
    trigger_condition_max: z
      .number()
      .int()
      .min(1)
      .max(99)
      .describe(
        'Upper bound of the trigger window - the event fires when projected condition falls to this'
      ),
    trigger_condition_min: z
      .number()
      .int()
      .min(0)
      .max(98)
      .optional()
      .describe(
        'Lower bound of the trigger window (default 0); an asset already below it has missed the event'
      ),
    impact_method: z
      .enum(['add_years', 'reset_condition'])
      .describe('Effect: add years of life, or reset condition to a value'),
    impact_add_years: z
      .number()
      .positive()
      .max(100)
      .optional()
      .describe('Years added (required when impact_method is add_years)'),
    impact_reset_to: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Condition after the event (required when impact_method is reset_condition)'),
    fixed_cost: z
      .number()
      .min(0)
      .optional()
      .describe('Fixed cost per application (current dollars, never indexed)'),
    cost_source: z
      .string()
      .max(200)
      .optional()
      .describe('Provenance of the cost ("Engineering 2026", a tender reference)'),
    max_applications: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("How many times the event may fire over an asset's life (default 1)"),
    min_years_between: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Minimum years between firings of a recurring event (default 1)'),
    sort_order: z.number().int().min(0).optional().describe('Evaluation order within the strategy'),
    work_generation: z
      .enum(['none', 'work_order', 'project'])
      .optional()
      .describe(
        'What a due application of this event becomes when created from the interventions list: none (plan only, default), work_order, or project. Nothing is created on a schedule.'
      ),
    work_generation_category_id: z
      .string()
      .guid()
      .optional()
      .describe(
        'Work category for generated work orders - resolve with list_work_categories. Ignored unless work_generation is work_order.'
      ),
    work_generation_priority: z
      .enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
      .optional()
      .describe(
        'Priority for generated work orders. Ignored unless work_generation is work_order.'
      ),
  }

  server.tool(
    'create_asset_lifecycle_event',
    "Create a facility lifecycle strategy event. Events attach to an asset-type SCOPE - exactly ONE of asset_type_id or asset_type_group_id - never to individual assets; an asset resolves its type's own strategy first, else its type group's. Replacement is NOT an event (it stays the renewal forecast + replacement value) - model the interventions BEFORE replacement: roof recoats, boiler retubes, overhauls. Resolve type ids with list_asset_types / list_asset_type_groups, and list existing events first to reuse a scope. Requires asset_lifecycle_events:write scope.",
    {
      name: z.string().max(200).describe('Event name (required, e.g. "Roof recoat")'),
      asset_type_id: z
        .string()
        .guid()
        .optional()
        .describe('Asset type the strategy scope applies to (exactly one of the two scope ids)'),
      asset_type_group_id: z
        .string()
        .guid()
        .optional()
        .describe('Asset type group the scope applies to (exactly one of the two scope ids)'),
      ...assetLifecycleEventFields,
    },
    async params => {
      try {
        const result = await client.create('asset-lifecycle-events', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset_lifecycle_event',
    'Update a facility lifecycle strategy event by ID. Editing re-confirms the cost (cost_reviewed_on is server-set). Set is_active false to disable an event without deleting it - projections recompute immediately. Requires asset_lifecycle_events:write scope.',
    {
      id: z.string().guid().describe('Lifecycle event ID'),
      name: z.string().max(200).optional().describe('Event name'),
      is_active: z.boolean().optional().describe('Disable/enable the event'),
      event_class: assetLifecycleEventFields.event_class.optional(),
      trigger_condition_max: assetLifecycleEventFields.trigger_condition_max.optional(),
      trigger_condition_min: assetLifecycleEventFields.trigger_condition_min,
      impact_method: assetLifecycleEventFields.impact_method.optional(),
      impact_add_years: assetLifecycleEventFields.impact_add_years,
      impact_reset_to: assetLifecycleEventFields.impact_reset_to,
      fixed_cost: assetLifecycleEventFields.fixed_cost,
      cost_source: assetLifecycleEventFields.cost_source,
      max_applications: assetLifecycleEventFields.max_applications,
      min_years_between: assetLifecycleEventFields.min_years_between,
      sort_order: assetLifecycleEventFields.sort_order,
      work_generation: assetLifecycleEventFields.work_generation,
      work_generation_category_id: assetLifecycleEventFields.work_generation_category_id,
      work_generation_priority: assetLifecycleEventFields.work_generation_priority,
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('asset-lifecycle-events', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset_lifecycle_event',
    'Delete a facility lifecycle strategy event by ID. Projections recompute immediately; consider update with is_active=false to disable instead. Requires asset_lifecycle_events:write scope.',
    { id: z.string().guid().describe('Lifecycle event ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('asset-lifecycle-events', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Asset Betterments (scope: asset_betterments)
  // ============================================================

  server.tool(
    'create_asset_betterment',
    "Record capital work that ALREADY extended a facility asset's life - an elevator modernization, a boiler retube, a major component replacement. Required: asset_id, occurred_on, and at least one of capitalized_amount or added_life_years (work that adds neither changes nothing and is rejected). The asset's net book value and remaining life re-base from occurred_on, and its purchase_date is NEVER changed - if a user asks to change an in-service date to reflect an overhaul, record this instead and say why. Use asset_lifecycle_events for work expected in future; use a condition assessment for what someone observed. Call list_assets first to resolve asset_id. Requires asset_betterments:write scope.",
    {
      asset_id: z.string().guid().describe('Asset the capital work was performed on (required)'),
      occurred_on: z
        .string()
        .describe(
          'Date the work went into service, YYYY-MM-DD (required). Not the invoice date - this is the date its value begins depreciating from.'
        ),
      capitalized_amount: z
        .number()
        .min(0)
        .optional()
        .describe(
          'Amount added to the asset value, in the organization currency (call get_organization_settings for currency_code). Required unless added_life_years is given.'
        ),
      added_life_years: z
        .number()
        .min(0.1)
        .max(200)
        .optional()
        .describe(
          'Extra service life the work bought, in years. Required unless capitalized_amount is given.'
        ),
      description: z.string().max(2000).optional().describe('What was actually done'),
      asset_lifecycle_event_id: z
        .string()
        .guid()
        .optional()
        .describe('The lifecycle strategy event this executed, if any'),
      work_order_id: z.string().guid().optional().describe('The work order that delivered it'),
      project_id: z.string().guid().optional().describe('The project that delivered it'),
      asset_cost_id: z
        .string()
        .guid()
        .optional()
        .describe('The asset cost row holding the spend, so the money is not double-entered'),
    },
    async params => {
      try {
        const result = await client.create('asset-betterments', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset_betterment',
    'Update a betterment by ID. The asset it belongs to cannot be changed - delete and re-create to move one. The row must still add either capital or life after the update. Requires asset_betterments:write scope.',
    {
      id: z.string().guid().describe('Betterment ID'),
      occurred_on: z.string().optional().describe('Date the work went into service, YYYY-MM-DD'),
      capitalized_amount: z.number().min(0).optional().describe('Amount added to the asset value'),
      added_life_years: z
        .number()
        .min(0.1)
        .max(200)
        .optional()
        .describe('Extra service life the work bought, in years'),
      description: z.string().max(2000).optional().describe('What was actually done'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('asset-betterments', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset_betterment',
    "Delete a betterment by ID. The asset's net book value and remaining life revert to what they were without it. Requires asset_betterments:write scope.",
    { id: z.string().guid().describe('Betterment ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('asset-betterments', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Asset Condition Assessments (scope: asset_condition_assessments)
  // ============================================================

  server.tool(
    'create_asset_condition_assessment',
    'Record a point-in-time condition assessment against an asset. Requires asset_condition_assessments:write scope. Call list_assets first to resolve asset_id.',
    {
      asset_id: z.string().guid().describe('Asset ID (required)'),
      assessed_on: z.string().describe('Assessment date (YYYY-MM-DD, required; today or earlier)'),
      condition_score: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('Condition score (0-100)'),
      replacement_cost: z
        .number()
        .min(0)
        .optional()
        .describe('Current replacement value / CRV at assessment time'),
      assessor_id: z.string().optional().describe('Assessor user ID'),
      method: z.enum(['visual', 'detailed', 'vendor']).optional().describe('Assessment method'),
      notes: z.string().optional().describe('Free-form notes'),
      defects: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Structured defect findings (JSON)'),
      update_purchase_cost: z
        .boolean()
        .optional()
        .describe(
          "Default OFF - omit unless the user explicitly asks to update/overwrite the asset's purchase cost, or says their org treats purchase cost as the current replacement value. Recording an assessment does NOT by itself change purchase cost. When true, overwrites assets.purchase_cost with this replacement_cost (CRV); the prior value is preserved on the assessment as previous_purchase_cost (read-only). Create-only and not reversible via update - when unsure, leave it off and ask."
        ),
    },
    async params => {
      try {
        const result = await client.create('asset-condition-assessments', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_asset_condition_assessment',
    'Update an existing asset condition assessment by ID. Requires asset_condition_assessments:write scope. Note: the purchase-cost writeback is create-only and cannot be triggered by an update.',
    {
      id: z.string().guid().describe('Assessment ID'),
      assessed_on: z.string().optional().describe('Assessment date (YYYY-MM-DD, today or earlier)'),
      condition_score: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('Condition score (0-100)'),
      replacement_cost: z.number().min(0).optional().describe('Current replacement value / CRV'),
      assessor_id: z.string().optional().describe('Assessor user ID'),
      method: z.enum(['visual', 'detailed', 'vendor']).optional().describe('Assessment method'),
      notes: z.string().optional().describe('Free-form notes'),
      defects: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Structured defect findings (JSON)'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('asset-condition-assessments', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_asset_condition_assessment',
    'Soft-delete an asset condition assessment by ID. Requires asset_condition_assessments:write scope.',
    { id: z.string().guid().describe('Assessment ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('asset-condition-assessments', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Infrastructure Asset Costs (scope: infrastructure_asset_costs)
  // ============================================================

  const INFRA_COST_CATEGORIES = [
    'Repair',
    'PM',
    'Operation',
    'Replacement',
    'Decommission',
    'Other',
  ] as const

  server.tool(
    'create_infrastructure_asset_cost',
    'Record a cost against an infrastructure feature. work_order_number is derived server-side from work_order_id; do not set it. Requires infrastructure_asset_costs:write scope.',
    {
      feature_id: z.string().guid().describe('Infrastructure feature ID (required)'),
      category: z.enum(INFRA_COST_CATEGORIES).describe('Cost category (required)'),
      amount: z.number().min(0).describe('Cost amount (required)'),
      cost_date: z.string().describe('Cost date (YYYY-MM-DD, required)'),
      invoice_number: z.string().max(200).optional().describe('Invoice number'),
      po_number: z.string().max(200).optional().describe('PO number'),
      purchase_order_id: z
        .string()
        .guid()
        .optional()
        .describe(
          "Purchase order that paid this cost - resolve via list_purchase_orders. Counts against the order's remaining balance unless the cost belongs to a work order."
        ),
      work_order_id: z.string().guid().optional().describe('Linked work order ID'),
    },
    async params => {
      try {
        const result = await client.create('infrastructure-asset-costs', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_infrastructure_asset_cost',
    'Update an infrastructure asset cost by ID. Requires infrastructure_asset_costs:write scope.',
    {
      id: z.string().guid().describe('Cost ID'),
      category: z.enum(INFRA_COST_CATEGORIES).optional().describe('Cost category'),
      amount: z.number().min(0).optional().describe('Cost amount'),
      cost_date: z.string().optional().describe('Cost date (YYYY-MM-DD)'),
      invoice_number: z.string().max(200).optional().describe('Invoice number'),
      po_number: z.string().max(200).optional().describe('PO number'),
      purchase_order_id: z
        .string()
        .guid()
        .nullable()
        .optional()
        .describe(
          "Purchase order that paid this cost - resolve via list_purchase_orders. Counts against the order's remaining balance unless the cost belongs to a work order; null clears it."
        ),
      work_order_id: z.string().guid().optional().describe('Linked work order ID'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('infrastructure-asset-costs', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_infrastructure_asset_cost',
    'Delete an infrastructure asset cost by ID. Requires infrastructure_asset_costs:write scope.',
    { id: z.string().guid().describe('Cost ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('infrastructure-asset-costs', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Infrastructure Asset Parts (scope: infrastructure_asset_parts)
  // ============================================================

  server.tool(
    'create_infrastructure_asset_part',
    'Associate a part with an infrastructure feature. The (feature_id, part_id) pair must be unique - a duplicate returns 409. Requires infrastructure_asset_parts:write scope.',
    {
      feature_id: z.string().guid().describe('Infrastructure feature ID (required)'),
      part_id: z.string().guid().describe('Part ID (required; resolve via list_parts)'),
      quantity: z.number().min(0).optional().describe('Design/installed quantity (default 1)'),
    },
    async params => {
      try {
        const result = await client.create('infrastructure-asset-parts', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_infrastructure_asset_part',
    'Update an infrastructure asset part association by ID. Requires infrastructure_asset_parts:write scope.',
    {
      id: z.string().guid().describe('Association ID'),
      feature_id: z.string().guid().optional().describe('Infrastructure feature ID'),
      part_id: z.string().guid().optional().describe('Part ID'),
      quantity: z.number().min(0).optional().describe('Design/installed quantity'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('infrastructure-asset-parts', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_infrastructure_asset_part',
    'Delete an infrastructure asset part association by ID. Requires infrastructure_asset_parts:write scope.',
    { id: z.string().guid().describe('Association ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('infrastructure-asset-parts', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Infrastructure Asset Documents (scope: infrastructure_asset_documents)
  // ============================================================

  server.tool(
    'create_infrastructure_asset_document',
    'Attach document metadata to an infrastructure feature. Upload the file bytes first via create_upload_url, then pass the returned file_path here. Requires infrastructure_asset_documents:write scope.',
    {
      feature_id: z.string().guid().describe('Infrastructure feature ID (required)'),
      name: z.string().max(500).describe('Document name (required)'),
      file_path: z.string().max(2000).describe('Storage path from create_upload_url (required)'),
      description: z.string().optional().describe('Description'),
      file_type: z.string().max(200).optional().describe('MIME type'),
      file_size: z.number().min(0).optional().describe('File size in bytes'),
      category: z.string().max(100).optional().describe('Document category'),
    },
    async params => {
      try {
        const result = await client.create('infrastructure-asset-documents', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_infrastructure_asset_document',
    'Update infrastructure asset document metadata by ID. Requires infrastructure_asset_documents:write scope.',
    {
      id: z.string().guid().describe('Document ID'),
      name: z.string().max(500).optional().describe('Document name'),
      file_path: z.string().max(2000).optional().describe('Storage path'),
      description: z.string().optional().describe('Description'),
      file_type: z.string().max(200).optional().describe('MIME type'),
      file_size: z.number().min(0).optional().describe('File size in bytes'),
      category: z.string().max(100).optional().describe('Document category'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('infrastructure-asset-documents', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_infrastructure_asset_document',
    'Delete an infrastructure asset document by ID. Requires infrastructure_asset_documents:write scope.',
    { id: z.string().guid().describe('Document ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('infrastructure-asset-documents', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Infrastructure Asset Comments (scope: infrastructure_asset_comments)
  // ============================================================

  server.tool(
    'create_infrastructure_asset_comment',
    'Add a comment to an infrastructure feature. The author is attributed to the API key automatically; do not pass user_id. Requires infrastructure_asset_comments:write scope.',
    {
      feature_id: z.string().guid().describe('Infrastructure feature ID (required)'),
      comment: z.string().max(10000).describe('Comment text (required)'),
    },
    async params => {
      try {
        const result = await client.create('infrastructure-asset-comments', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_infrastructure_asset_comment',
    'Update an infrastructure asset comment by ID. Requires infrastructure_asset_comments:write scope.',
    {
      id: z.string().guid().describe('Comment ID'),
      comment: z.string().max(10000).optional().describe('Comment text'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('infrastructure-asset-comments', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_infrastructure_asset_comment',
    'Delete an infrastructure asset comment by ID. Requires infrastructure_asset_comments:write scope.',
    { id: z.string().guid().describe('Comment ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('infrastructure-asset-comments', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Infrastructure Zones (scope: infrastructure_zones)
  // ============================================================

  const INFRA_ZONE_KINDS = [
    'pressure_zone',
    'dma',
    'sewershed',
    'storm_catchment',
    'maintenance_district',
  ] as const

  const geoJsonBoundary = z
    .union([
      z.object({
        type: z.literal('Polygon'),
        coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
      }),
      z.object({
        type: z.literal('MultiPolygon'),
        coordinates: z.array(z.array(z.array(z.tuple([z.number(), z.number()])))),
      }),
    ])
    .describe(
      'GeoJSON Polygon or MultiPolygon (EPSG:4326). Each ring is closed; coordinates are [lon, lat]. Use MultiPolygon for a boundary in separate pieces - an area split by a rail corridor, or one containing an island.'
    )

  server.tool(
    'create_infrastructure_zone',
    'Create an operational hydraulic boundary (pressure zone, DMA, sewershed, etc.). boundary is a GeoJSON Polygon, or a MultiPolygon when the area comes in separate pieces. (network_id, name) must be unique. Requires infrastructure_zones:write scope.',
    {
      network_id: z.string().guid().describe('Infrastructure network ID (required)'),
      kind: z.enum(INFRA_ZONE_KINDS).describe('Zone kind (required)'),
      name: z.string().max(200).describe('Zone name (required)'),
      boundary: geoJsonBoundary,
      code: z.string().max(50).optional().describe('Optional short code (e.g. "PZ-04")'),
      notes: z.string().optional().describe('Free-form notes'),
    },
    async params => {
      try {
        const result = await client.create('infrastructure-zones', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_infrastructure_zone',
    'Update an infrastructure zone by ID. Pass boundary as a GeoJSON Polygon or MultiPolygon to replace the geometry. Requires infrastructure_zones:write scope.',
    {
      id: z.string().guid().describe('Zone ID'),
      network_id: z.string().guid().optional().describe('Infrastructure network ID'),
      kind: z.enum(INFRA_ZONE_KINDS).optional().describe('Zone kind'),
      name: z.string().max(200).optional().describe('Zone name'),
      boundary: geoJsonBoundary.optional(),
      code: z.string().max(50).optional().describe('Optional short code'),
      notes: z.string().optional().describe('Free-form notes'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('infrastructure-zones', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_infrastructure_zone',
    'Delete an infrastructure zone by ID. Requires infrastructure_zones:write scope.',
    { id: z.string().guid().describe('Zone ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('infrastructure-zones', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Project ↔ Infrastructure Asset links (scope: project_infrastructure_assets)
  // ============================================================

  server.tool(
    'create_project_infrastructure_asset',
    'Link a project to an infrastructure feature. The (project_id, feature_id) pair must be unique - a duplicate returns 409. Requires project_infrastructure_assets:write scope.',
    {
      project_id: z.string().guid().describe('Project ID (required)'),
      feature_id: z.string().guid().describe('Infrastructure feature ID (required)'),
      notes: z.string().optional().describe('Free-form notes'),
    },
    async params => {
      try {
        const result = await client.create('project-infrastructure-assets', buildBody(params))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'update_project_infrastructure_asset',
    'Update a project ↔ infrastructure feature link by ID. Requires project_infrastructure_assets:write scope.',
    {
      id: z.string().guid().describe('Link ID'),
      project_id: z.string().guid().optional().describe('Project ID'),
      feature_id: z.string().guid().optional().describe('Infrastructure feature ID'),
      notes: z.string().optional().describe('Free-form notes'),
    },
    async ({ id, ...rest }) => {
      try {
        const result = await client.update('project-infrastructure-assets', id, buildBody(rest))
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  server.tool(
    'delete_project_infrastructure_asset',
    'Delete a project ↔ infrastructure feature link by ID. Requires project_infrastructure_assets:write scope.',
    { id: z.string().guid().describe('Link ID') },
    async ({ id }) => {
      try {
        const result = await client.remove('project-infrastructure-assets', id)
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )

  // ============================================================
  // Bulk Operations
  // ============================================================

  server.tool(
    'bulk_update',
    'Update multiple records of a resource type in one API call (max 100). Each item must include an "id" field (UUID). Each item is processed independently - one failure does not affect others. Returns per-item results. Requires {resource}:write scope. Counts as 1 request for rate limiting.',
    {
      resource: z.enum(BULK_RESOURCES).describe('Resource type (e.g. "assets", "work-orders")'),
      items: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .max(100)
        .describe(
          'Array of objects to update (max 100). Each must include an "id" field (UUID) plus fields to change.'
        ),
    },
    async ({ resource, items }) => {
      try {
        const result = await client.bulkUpdate(resource, items as Record<string, unknown>[])
        return formatResult(result)
      } catch (err) {
        return formatError(err)
      }
    }
  )
}
