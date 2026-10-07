#!/usr/bin/env node
/**
 * AssetLab MCP Server
 *
 * Connects Claude Desktop / Claude Code to AssetLab via the API Gateway.
 * Runs locally over stdio — no network server exposed.
 *
 * Required env vars:
 *   ASSETLAB_API_KEY  - API key from AssetLab Settings > API Keys
 *   ASSETLAB_API_URL  - API Gateway URL (e.g., https://<project>.supabase.co/functions/v1/api-gateway)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { AssetLabClient, loadConfig } from './client.js'
import { registerTools, SERVER_INSTRUCTIONS } from './tools.js'
import { VERSION } from './version.js'

async function main() {
  const config = loadConfig()
  const client = new AssetLabClient(config)

  const server = new McpServer(
    {
      name: 'assetlab',
      version: VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    }
  )

  registerTools(server, client)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
