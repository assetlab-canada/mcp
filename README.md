# AssetLab MCP Server

[![npm version](https://img.shields.io/npm/v/%40assetlab%2Fmcp-server?color=cb3837&logo=npm)](https://www.npmjs.com/package/@assetlab/mcp-server)
[![weekly downloads](https://img.shields.io/npm/dw/%40assetlab%2Fmcp-server?color=blue)](https://www.npmjs.com/package/@assetlab/mcp-server)
[![types](https://img.shields.io/badge/types-included-3178c6?logo=typescript&logoColor=white)](https://www.npmjs.com/package/@assetlab/mcp-server)
[![license](https://img.shields.io/npm/l/%40assetlab%2Fmcp-server?color=green)](https://opensource.org/licenses/MIT)

**Talk to your assets.** Connect Claude, ChatGPT, Microsoft Copilot, or any MCP-compatible client to your
[AssetLab](https://assetlab.ca) account through the
[Model Context Protocol](https://modelcontextprotocol.io) - ask about work orders, PM
schedules, capital plans, and infrastructure networks in plain language, and create or
update records hands-free.

> **480+ tools** across **100+ resources** · scoped, tenant-bound, audited ·
> read *and* write · hosted or local

---

## Quick start

### Claude.ai (hosted - easiest)

1. Create an API key in **AssetLab → Settings → API Keys**
2. In Claude.ai: **Settings → Connectors → Add connector**
3. Paste the connector URL: `https://mcp.assetlab.ca`
4. When prompted for auth, paste your API key (`al_live_...`)

### ChatGPT

1. Create an API key in **AssetLab → Settings → API Keys**
2. In ChatGPT: **Settings → Apps & Connectors → Add new connector**
3. Name it (e.g. `AssetLab`) and enter the server URL: `https://mcp.assetlab.ca`
4. Set authentication to **OAuth** and click **Create** - the OAuth endpoints are
   auto-discovered
5. On the AssetLab authorization page, paste your API key (`al_live_...`)

### Microsoft Copilot (via Copilot Studio)

Copilot chat has no "add a server" field, so one person builds an agent once and publishes
it; staff then use that agent inside ordinary Microsoft 365 Copilot.

1. Create an API key in **AssetLab → Settings → API Keys**
2. In [Copilot Studio](https://copilotstudio.microsoft.com), open an agent with generative
   orchestration and choose **Tools → Add a tool → New tool → Model Context Protocol**
3. Server URL: `https://mcp.assetlab.ca/mcp?profile=core`
4. Authentication **API key**, type **Header**, header name `Authorization`; the connection
   value is `Bearer al_live_...`
5. Publish the agent to the **Microsoft 365 Copilot** channel and have an admin approve it

Use the `?profile=core` address here. Copilot Studio caps an agent at 128 tools and
recommends 25-30; this server publishes 480+, and the `core` profile answers with 28
covering sites, buildings, assets, work orders, work requests, PM schedules and vendors.
Claude and ChatGPT have no such cap and should use the plain URL.

### Claude Desktop / Claude Code (local, stdio)

This package runs as a local MCP server over stdio - nothing is exposed on the network.

```json
{
  "mcpServers": {
    "assetlab": {
      "command": "npx",
      "args": ["-y", "@assetlab/mcp-server"],
      "env": {
        "ASSETLAB_API_KEY": "al_live_...",
        "ASSETLAB_API_URL": "https://<your-project>.supabase.co/functions/v1/api-gateway"
      }
    }
  }
}
```

Your AssetLab administrator can provide the API URL for your organization.

---

## What can you ask?

| You say | It does |
|---|---|
| *"Show me all overdue work orders"* | Lists them, sorted, with links back to AssetLab |
| *"Create a work order for the broken pump in Building 3"* | Looks up the building and asset, then creates it |
| *"Which projects are at risk or delayed?"* | Scans project status and risks |
| *"What's the total cost history for Asset X?"* | Aggregates every cost record |
| *"List watermains over 500 mm in poor condition"* | Filters infrastructure features by diameter and condition |
| *"Add a crack-sealing event to the sidewalk strategy at $4 per square metre"* | Maintains your lifecycle strategies |
| *"What PM schedules are due this month?"* | Checks every schedule's next due date |
| *"Update the priority on WO-1234 to urgent"* | Edits the record (with your write scope) |

---

## What's new in 2.7

**A curated tool profile for Microsoft Copilot.** Adding `?profile=core` to the hosted
server URL publishes 28 tools instead of 480+, which is what makes the server usable in
clients that cap how many tools one agent may host - Microsoft Copilot Studio allows 128
and recommends 25-30. An unrecognized profile name is rejected rather than quietly serving
the full catalog. Claude and ChatGPT are unaffected and keep the full tool set.

---

## What's new in 2.5

**Facility lifecycle strategies.** The lifecycle strategy tools now cover buildings and
equipment, not just linear infrastructure. Five new tools under the
`asset_lifecycle_events` scope read and maintain condition-triggered interventions
("roof recoat at condition 70-85 adds five years"). Events attach to an asset type or an
asset type group rather than to individual assets, so one event maintains a whole class
of equipment.

**Events say what work they become.** Lifecycle events on both sides now carry a
`work_generation` setting - plan only, work order, or project - so a due intervention
records what it should turn into. Nothing is created on a schedule; the interventions
lists remain where that decision is made.

---

## Tool catalog

Tools follow one naming pattern throughout: `list_*` / `get_*` to read, `create_*` /
`update_*` / `delete_*` to write. **Read** below means list/get; **Write** means
create/update/delete (availability varies slightly per resource - the tool descriptions
are the authority).

<details>
<summary><b>Assets &amp; maintenance records</b> (17 resources)</summary>

| Resource | Read | Write |
|---|:-:|:-:|
| Assets | ✓ | ✓ |
| Asset comments · costs · documents · parts | ✓ | ✓ |
| Asset placements (floorplan pins) | ✓ | ✓ |
| Asset replacement plans | ✓ | ✓ |
| Asset condition assessments | ✓ | ✓ |
| Asset lifecycle events (strategies) | ✓ | ✓ |
| Asset risk history | ✓ | - |
| Asset statuses · types · type groups | ✓ | ✓ |
| Attachments (+ `upload_file`, `create_upload_url`) | ✓ | ✓ |
| Manufacturers | ✓ | ✓ |
| Parts · part categories | ✓ | ✓ |

</details>

<details>
<summary><b>Work management</b> (7 resources)</summary>

| Resource | Read | Write |
|---|:-:|:-:|
| Work orders | ✓ | ✓ |
| Work order comments · schedules | ✓ | ✓ |
| Work requests | ✓ | ✓ |
| Work categories | ✓ | ✓ |
| PM schedules | ✓ | ✓ |
| PM templates | ✓ | ✓ |

</details>

<details>
<summary><b>Sites, buildings &amp; systems</b> (11 resources)</summary>

| Resource | Read | Write |
|---|:-:|:-:|
| Sites | ✓ | ✓ |
| Site FCI history | ✓ | - |
| Buildings · building types | ✓ | ✓ |
| Locations · location types | ✓ | ✓ |
| Systems · system classes · system groups | ✓ | ✓ |
| Floorplans · floorplan regions | ✓ | ✓ |

</details>

<details>
<summary><b>Infrastructure (linear assets)</b> (11 resources)</summary>

| Resource | Read | Write |
|---|:-:|:-:|
| Feature classes | ✓ | ✓ |
| Networks | ✓ | ✓ |
| Features (segments &amp; nodes, GeoJSON geometry) | ✓ | ✓ |
| Feature inspections | ✓ | ✓ |
| Lifecycle events (strategies) | ✓ | ✓ |
| Zones | ✓ | ✓ |
| Feature comments · costs · documents · parts | ✓ | ✓ |
| Feature risk history | ✓ | - |

</details>

<details>
<summary><b>Projects &amp; capital planning</b> (20+ resources)</summary>

| Resource | Read | Write |
|---|:-:|:-:|
| Projects | ✓ | ✓ |
| Tasks · task dependencies · milestones | ✓ | ✓ |
| Phases · phase categories | ✓ | ✓ |
| Budget items · time entries · cost snapshots | ✓ | ✓ |
| Comments · updates · risks · team members | ✓ | ✓ |
| Documents · document folder templates | ✓ | ✓ |
| Project links (assets, buildings, sites, locations, systems, infrastructure) | ✓ | ✓ |
| Service areas (+ site and system-class links) | ✓ | ✓ |

</details>

<details>
<summary><b>Finance &amp; vendors</b> (10 resources)</summary>

| Resource | Read | Write |
|---|:-:|:-:|
| Budgets | ✓ | ✓ |
| Expenses · invoices · purchase orders | ✓ | ✓ |
| Change orders | ✓ | ✓ |
| Cost categories | ✓ | ✓ |
| Contracts · contract sites · contract documents | ✓ | ✓ |
| Vendors · vendor site assignments | ✓ | ✓ |

</details>

<details>
<summary><b>Compliance, forms &amp; level of service</b> (15 resources)</summary>

| Resource | Read | Write |
|---|:-:|:-:|
| Compliance items · records | ✓ | ✓ |
| Form templates · template items | ✓ | ✓ |
| Form responses | ✓ | ✓ |
| Form response answers | ✓ | - |
| LoS measures · measurements | ✓ | ✓ |
| LoS proposed targets | ✓ | ✓ |
| LoS targets history | ✓ | - |
| LoS system targets · infrastructure targets | ✓ | ✓ |
| Criticality modifiers | ✓ | ✓ |
| LoS consequences | ✓ | ✓ |
| LoS status snapshots | ✓ | - |

</details>

<details>
<summary><b>Admin &amp; analytics</b> (6 resources)</summary>

| Resource | Read | Write |
|---|:-:|:-:|
| Users | ✓ | - |
| Custom field definitions · values | ✓ | ✓ |
| Dashboard summary · snapshots | ✓ | - |
| Bulk operations (`bulk_create`, `bulk_update`) | - | ✓ |

</details>

---

## Scopes

API keys use scopes to control exactly what your assistant can touch. Configure
per-resource read and write access in **Settings → API Keys** - scopes are grouped by
category (Operations, Facilities, Projects, Finance, Infrastructure, ...) with
bulk-toggle controls.

| Scope pattern | Access |
|---|---|
| `resource:read` | List and get records (e.g. `assets:read`, `work_orders:read`) |
| `resource:write` | Create, update, and delete records (e.g. `assets:write`) |
| `*:*` | Full access to all resources |

---

## Security

- **OAuth 2.0 + PKCE** through `mcp.assetlab.ca`; your API key is encrypted in
  transit and never stored by the MCP server
- **Tenant-bound** - every key is scoped to your organization only, and the server
  ignores any attempt to address another tenant
- **Audited** - all data access is logged in AssetLab's audit log
- **Revocable** - revoke a key any time in **Settings → API Keys**; it dies instantly
- **Read-only by default** - write operations require explicit write scopes

---

## Support

Questions or issues? Email [support@assetlab.ca](mailto:support@assetlab.ca).

Docs: [assetlab.ca](https://assetlab.ca) → **Docs → AI & MCP**
