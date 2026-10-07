/**
 * MCP Apps: tools whose result renders as an interactive view in hosts that
 * support the io.modelcontextprotocol/ui extension. Hosts without it ignore
 * _meta and show the text content, which is a complete answer on its own.
 *
 * Registered apart from registerTools() so the ?profile=core catalogue stays
 * as it is.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { AssetLabClient } from '../client.js'
import { formatError, formatResult } from '../response-shaping.js'
import { toolAnnotations } from '../tool-annotations.js'
import { FCI_FAIR_BOUND, FCI_GOOD_BOUND, SITE_FCI_TREND_HTML } from './site-fci-trend-view.js'

export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'
export const SITE_FCI_TREND_URI = 'ui://assetlab/site-fci-trend.html'

const DEFAULT_DAYS = 365
const MAX_DAYS = 3650
const MS_PER_DAY = 86_400_000

type FciBand = 'good' | 'fair' | 'poor'

type FciHistoryRow = {
  fci_value: number
  recorded_date: string
  sites?: { id: string; name: string | null } | null
}

function fciBand(fci: number): FciBand {
  if (fci < FCI_GOOD_BOUND) return 'good'
  if (fci < FCI_FAIR_BOUND) return 'fair'
  return 'poor'
}

function percent(fci: number): string {
  return `${(fci * 100).toFixed(1)}%`
}

function uiMeta(resourceUri: string): Record<string, unknown> {
  // The flat key is the pre-2026 spelling; current hosts read ui.resourceUri.
  return { ui: { resourceUri }, 'ui/resourceUri': resourceUri }
}

export function registerApps(server: McpServer, client: AssetLabClient): void {
  server.registerResource(
    'site_fci_trend_view',
    SITE_FCI_TREND_URI,
    {
      title: 'Site FCI trend',
      description: 'Interactive chart of one site’s Facility Condition Index over time.',
      mimeType: MCP_APP_MIME_TYPE,
    },
    async uri => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME_TYPE,
          text: SITE_FCI_TREND_HTML,
          // Empty CSP: no network origins at all. The view gets its data from the tool result only.
          _meta: { ui: { csp: {}, prefersBorder: true } },
        },
      ],
    })
  )

  const name = 'show_site_fci_trend'
  server.registerTool(
    name,
    {
      title: toolAnnotations(name).title,
      description:
        'Show one site’s Facility Condition Index (FCI) history as a chart, in clients that render MCP Apps; other clients get the same summary as text. FCI is deferred renewal cost divided by current replacement value, a fraction where LOWER is healthier: good below 5%, fair 5-10%, poor 10% and above. It is not a 0-100 condition score. Resolve site_id with list_sites first.',
      inputSchema: z.object({
        site_id: z.string().guid().describe('Site ID (required). Get it from list_sites.'),
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_DAYS)
          .optional()
          .describe(`How many days back to chart. Default ${DEFAULT_DAYS}.`),
      }),
      annotations: toolAnnotations(name),
      _meta: uiMeta(SITE_FCI_TREND_URI),
    },
    async ({ site_id, days }) => {
      try {
        const windowDays = days ?? DEFAULT_DAYS
        const [history, site] = await Promise.all([
          client.listAll<FciHistoryRow>('site-fci-history', { site_id }),
          client.getOne<{ id: string; name: string | null }>('sites', site_id),
        ])
        const cutoff = new Date(Date.now() - windowDays * MS_PER_DAY).toISOString().slice(0, 10)
        const points = history.data
          .filter(row => row.recorded_date >= cutoff)
          .map(row => ({ date: row.recorded_date, fci: Number(row.fci_value) }))
          .sort((a, b) => a.date.localeCompare(b.date))

        const last = points.at(-1)
        const latest = last ? { ...last, band: fciBand(last.fci) } : null
        const siteInfo = { id: site.data.id, name: site.data.name }
        const values = points.map(p => p.fci)

        const summary = latest
          ? `${siteInfo.name ?? 'Site'}: FCI ${percent(latest.fci)} (${latest.band}) on ${latest.date}. ` +
            `${points.length} readings in the last ${windowDays} days, ranging ${percent(Math.min(...values))} to ${percent(Math.max(...values))}. ` +
            `Lower is healthier: good below ${FCI_GOOD_BOUND * 100}%, fair to ${FCI_FAIR_BOUND * 100}%, poor above.`
          : `${siteInfo.name ?? 'Site'} has no FCI readings in the last ${windowDays} days. A site gets a reading only when at least half of its priced replacement value has a known remaining life.`

        const structuredContent = { site: siteInfo, days: windowDays, points, latest }
        const text = formatResult({ summary, site: siteInfo, latest, readings: points.length })
        return { ...text, structuredContent }
      } catch (err) {
        return formatError(err)
      }
    }
  )
}
