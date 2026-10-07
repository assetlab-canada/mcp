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

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { registerApps } from './apps/index.js'
import { AssetLabClient, loadConfig } from './client.js'
import { registerTools, SERVER_INSTRUCTIONS } from './tools.js'
import { VERSION } from './version.js'

function main() {
  const config = loadConfig()
  const client = new AssetLabClient(config)

  // The opening exchange picks the era (2025 handshake or 2026-07-28 discover) for the connection.
  serveStdio(() => {
    const server = new McpServer(
      { name: 'assetlab', version: VERSION },
      { instructions: SERVER_INSTRUCTIONS }
    )
    registerTools(server, client)
    registerApps(server, client)
    return server
  })
}

try {
  main()
} catch (err) {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
}
