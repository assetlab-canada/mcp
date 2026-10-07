/**
 * AssetLab MCP Remote Server - Cloudflare Worker
 *
 * HTTP/SSE transport for Claude.ai custom connectors.
 * Implements OAuth 2.0 + PKCE so Claude.ai can authenticate, then proxies
 * MCP tool calls through the AssetLab API Gateway with the user's API key.
 *
 * Required env vars (wrangler.toml [vars] or Cloudflare dashboard secrets):
 *   ASSETLAB_API_URL  - API Gateway URL
 *   OAUTH_SECRET      - 32+ char random string for encrypting auth codes
 * Rate limiting bindings ([[ratelimits]] in wrangler.toml): REQUEST_LIMITER,
 * REGISTER_IP_LIMITER, REGISTER_GLOBAL_LIMITER.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { AssetLabClient } from './client.js'
import {
  authServerMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleDelete,
  handleRegister,
  handleRevoke,
  handleToken,
  protectedResourceMetadata,
  resolveAccessToken,
} from './oauth.js'
import {
  isToolProfile,
  PROFILE_INSTRUCTIONS,
  TOOL_PROFILES,
  withToolProfile,
} from './tool-profiles.js'
import { registerTools, SERVER_INSTRUCTIONS } from './tools.js'
import { VERSION } from './version.js'

// Minimal subset of Cloudflare's KVNamespace surface - we don't depend on
// @cloudflare/workers-types, so declare just what oauth.ts consumes.
export interface KVNamespace {
  get(key: string, options?: { type?: 'text' }): Promise<string | null>
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number }
  ): Promise<void>
  delete(key: string): Promise<void>
}

// Cloudflare Workers Rate Limiting binding. Counts are kept per edge location, so limits are approximate.
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  ASSETLAB_API_URL: string
  OAUTH_SECRET: string
  OAUTH_CLIENTS: KVNamespace
  REQUEST_LIMITER: RateLimiter
  REGISTER_IP_LIMITER: RateLimiter
  REGISTER_GLOBAL_LIMITER: RateLimiter
}

const RATE_LIMIT_RETRY_SECONDS = 60

const ALLOWED_ORIGINS = new Set([
  'https://claude.ai',
  'https://chat.openai.com',
  'https://chatgpt.com',
])

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? ''
  if (!ALLOWED_ORIGINS.has(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Accept',
  }
}

const SERVER_INFO = { name: 'assetlab', version: VERSION }

function jsonResponse(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
  corsFor?: Request
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(corsFor ? corsHeaders(corsFor) : {}),
      ...extra,
    },
  })
}

function rateLimited(corsFor?: Request): Response {
  return jsonResponse(
    {
      error: 'rate_limited',
      error_description: `Too many requests. Retry after ${RATE_LIMIT_RETRY_SECONDS} seconds.`,
    },
    429,
    { 'Retry-After': String(RATE_LIMIT_RETRY_SECONDS) },
    corsFor
  )
}

function withCors(response: Response, request: Request): Response {
  const cors = corsHeaders(request)
  if (Object.keys(cors).length === 0) return response
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Normalize the Accept header so the MCP SDK transport doesn't reject with 406.
 */
function normalizeRequest(request: Request): Request {
  if (request.method !== 'POST') return request

  const accept = request.headers.get('Accept') ?? ''
  if (accept.includes('application/json') && accept.includes('text/event-stream')) {
    return request
  }

  const headers = new Headers(request.headers)
  headers.set('Accept', 'application/json, text/event-stream')

  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - duplex needed for streaming body in Workers
    duplex: 'half',
  })
}

const FAVICON_ORIGIN = 'https://app.assetlab.ca'
const FAVICON_PATHS = new Set(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png'])
const FAVICON_CACHE_SECONDS = 86_400

async function serveFavicon(pathname: string): Promise<Response> {
  const upstream = await fetch(`${FAVICON_ORIGIN}${pathname}`)
  if (!upstream.ok) return new Response(null, { status: 404 })
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
      'Cache-Control': `public, max-age=${FAVICON_CACHE_SECONDS}`,
    },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = url.origin

    // CORS preflight - only emit allow-* headers for trusted origins; unknown
    // origins get a bare 204 which fails the preflight in the browser.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }

    // Claude's connector directory shows the server URL's favicon; without this it hits the 401 probe.
    if (
      FAVICON_PATHS.has(url.pathname) &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      return serveFavicon(url.pathname)
    }

    // Bounds what one caller can cost us: every request below may read KV or call the gateway.
    const clientIp = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    if (!(await env.REQUEST_LIMITER.limit({ key: clientIp })).success) {
      return rateLimited(request)
    }

    if (!env.ASSETLAB_API_URL) {
      return jsonResponse({ error: 'Server misconfigured: ASSETLAB_API_URL not set.' }, 500)
    }

    // ── OAuth 2.0 routes ──────────────────────────────────────────────────

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      return protectedResourceMetadata(origin, request)
    }
    if (
      url.pathname === '/.well-known/oauth-authorization-server' ||
      url.pathname === '/.well-known/openid-configuration'
    ) {
      return authServerMetadata(origin, request)
    }
    if (url.pathname === '/oauth/register' && request.method === 'POST') {
      // Unauthenticated and writes a permanent KV record; the global cap bounds a distributed flood.
      if (!(await env.REGISTER_IP_LIMITER.limit({ key: clientIp })).success) return rateLimited()
      if (!(await env.REGISTER_GLOBAL_LIMITER.limit({ key: 'global' })).success)
        return rateLimited()
      return handleRegister(request, env.OAUTH_CLIENTS)
    }
    // RFC 7592 client management - DELETE /oauth/register/{client_id}
    if (url.pathname.startsWith('/oauth/register/') && request.method === 'DELETE') {
      const clientId = url.pathname.slice('/oauth/register/'.length)
      return handleDelete(request, env.OAUTH_CLIENTS, clientId)
    }
    if (url.pathname === '/authorize' && request.method === 'GET') {
      return handleAuthorizeGet(request, env.OAUTH_CLIENTS)
    }
    if (url.pathname === '/authorize' && request.method === 'POST') {
      return handleAuthorizePost(request, env)
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      return handleToken(request, env)
    }
    if (url.pathname === '/oauth/revoke' && request.method === 'POST') {
      return handleRevoke(request, env)
    }

    // ── Health / connectivity probes ──────────────────────────────────────
    // Return 401 for unauthenticated requests so Claude.ai triggers the OAuth
    // flow instead of showing "already connected".

    const authHeader = request.headers.get('Authorization')

    const wwwAuthenticate = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`

    if (request.method === 'HEAD') {
      if (!authHeader) {
        return new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': wwwAuthenticate, ...corsHeaders(request) },
        })
      }
      return new Response(null, { status: 200, headers: corsHeaders(request) })
    }

    if (request.method === 'GET') {
      const accepts = request.headers.get('Accept') ?? ''
      if (accepts.includes('text/event-stream')) {
        // SSE keepalive stream - keeps ChatGPT's "connected" state alive by sending
        // comment pings every 20s. Actual tool calls go via POST; this channel only
        // exists to prevent idle-timeout disconnects.
        if (!authHeader) {
          return new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': wwwAuthenticate, ...corsHeaders(request) },
          })
        }
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
        const writer = writable.getWriter()
        const encoder = new TextEncoder()
        const ping = () =>
          writer.write(encoder.encode(': ping\n\n')).catch(() => clearInterval(timer))
        ping()
        const timer = setInterval(ping, 20_000)
        request.signal?.addEventListener('abort', () => {
          clearInterval(timer)
          writer.close().catch(() => {
            /* noop */
          })
        })
        return new Response(readable, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...corsHeaders(request),
          },
        })
      }
      if (!authHeader) {
        return jsonResponse(
          { error: 'unauthorized', error_description: 'Bearer token required' },
          401,
          { 'WWW-Authenticate': wwwAuthenticate },
          request
        )
      }
      return jsonResponse({ ...SERVER_INFO, status: 'ok' }, 200, {}, request)
    }

    // ── MCP transport ─────────────────────────────────────────────────────

    // Gate POST against the same Bearer requirement as GET/HEAD. Without this,
    // initialize/tools/list leak the full tool catalog + SERVER_INSTRUCTIONS
    // to any unauthenticated caller (pentest finding F-002).
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse(
        { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: Bearer token required' } },
        401,
        { 'WWW-Authenticate': wwwAuthenticate },
        request
      )
    }

    // Resolve the Bearer token: `mcp_at_*` tokens are looked up in KV and
    // mapped to the underlying AssetLab API key; legacy `al_*` tokens pass
    // through. Unknown / expired tokens → 401, which makes Claude.ai re-run
    // the OAuth flow rather than show a stale "connected" state.
    const presentedToken = authHeader.slice(7).trim()
    const resolved = await resolveAccessToken(env.OAUTH_CLIENTS, presentedToken)
    if (!resolved) {
      return jsonResponse(
        {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: token expired or revoked' },
        },
        401,
        { 'WWW-Authenticate': wwwAuthenticate },
        request
      )
    }
    const apiKey = resolved.apiKey

    // `?profile=core` trims the catalog for clients that cap tools per agent.
    // A typo must fail loudly here - silently serving all 466 is the bug.
    const requestedProfile = url.searchParams.get('profile')
    if (requestedProfile !== null && !isToolProfile(requestedProfile)) {
      return jsonResponse(
        {
          jsonrpc: '2.0',
          error: {
            code: -32602,
            message: `Unknown tool profile "${requestedProfile}". Valid profiles: ${Object.keys(TOOL_PROFILES).join(', ')}. Omit the parameter for the full tool set.`,
          },
        },
        400,
        {},
        request
      )
    }

    const client = new AssetLabClient({ apiKey, apiUrl: env.ASSETLAB_API_URL })
    const instructions = requestedProfile
      ? SERVER_INSTRUCTIONS + PROFILE_INSTRUCTIONS[requestedProfile]
      : SERVER_INSTRUCTIONS
    const server = new McpServer(SERVER_INFO, { instructions })
    registerTools(requestedProfile ? withToolProfile(server, requestedProfile) : server, client)

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })

    await server.connect(transport)

    const normalizedRequest = normalizeRequest(request)

    try {
      const response = await transport.handleRequest(normalizedRequest)
      return withCors(response, request)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error'
      return jsonResponse({ jsonrpc: '2.0', error: { code: -32603, message } }, 500, {}, request)
    }
  },
}
