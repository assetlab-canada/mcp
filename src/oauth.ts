/**
 * OAuth 2.0 Authorization Server for AssetLab MCP.
 *
 * Implements the subset of OAuth 2.0 + PKCE + RFC 7591/7592 needed to satisfy
 * MCP connectors (Claude.ai, ChatGPT):
 *   - /oauth/register   POST   - dynamic client registration with KV-backed allow-list
 *   - /oauth/register/{id} DELETE - authenticated client deletion
 *   - /authorize        GET    - consent page (validates client + redirect_uri)
 *   - /authorize        POST   - issues an encrypted authorization code
 *   - /token            POST   - code/refresh exchange (PKCE S256 mandatory)
 *
 * The user's AssetLab API key is still returned as the OAuth access_token
 * (P0 hardening keeps this; the opaque-token swap is tracked as P1).
 */

import type { KVNamespace } from './worker.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(secret)
  const hash = await crypto.subtle.digest('SHA-256', raw)
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function encrypt(payload: string, secret: string): Promise<string> {
  const key = await deriveKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(payload)
  )
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return base64url(combined)
}

async function decrypt(code: string, secret: string): Promise<string> {
  const data = fromBase64url(code)
  const iv = data.slice(0, 12)
  const ciphertext = data.slice(12)
  const key = await deriveKey(secret)
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(decrypted)
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ── Types ────────────────────────────────────────────────────────────────────

interface OAuthClient {
  client_id: string
  client_name: string
  redirect_uris: string[]
  scope: string
  registration_access_token_hash: string
  created_at: number
}

interface CodePayload {
  apiKey: string
  codeChallenge: string
  redirectUri: string
  scope: string
  clientId: string
  exp: number
}

interface RefreshPayload {
  apiKey: string
  scope: string
  clientId?: string
  type: 'refresh'
}

interface AccessTokenRecord {
  // AES-GCM ciphertext of the API key under a key derived from the access token (F-250).
  api_key_enc?: string
  // Plaintext form written before F-250; read only until those 24h records expire.
  api_key?: string
  scope: string
  client_id?: string
  created_at: number
}

// Opaque access tokens are prefixed so the Worker can distinguish them from
// legacy API-key-as-Bearer requests (which start with al_live_ / al_test_).
const ACCESS_TOKEN_PREFIX = 'mcp_at_'
const ACCESS_TOKEN_TTL_SECONDS = 86_400 // 24h - matches the `expires_in` in /token response

// ── KV helpers ───────────────────────────────────────────────────────────────

const CLIENT_KEY = (id: string) => `oauth_client:${id}`
const TOKEN_KEY = (hash: string) => `oauth_token:${hash}`
const CONSUMED_CODE_KEY = (hash: string) => `consumed_code:${hash}`

async function getClient(kv: KVNamespace, id: string): Promise<OAuthClient | null> {
  if (!id) return null
  const raw = await kv.get(CLIENT_KEY(id))
  if (!raw) return null
  try {
    return JSON.parse(raw) as OAuthClient
  } catch {
    return null
  }
}

async function putClient(kv: KVNamespace, client: OAuthClient): Promise<void> {
  await kv.put(CLIENT_KEY(client.client_id), JSON.stringify(client))
}

async function deleteClient(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(CLIENT_KEY(id))
}

// The KV key is SHA-256(token); the encryption key is HKDF(token) under a distinct label, so
// neither KV contents nor OAUTH_SECRET alone recover the API key - only the token holder can.
async function tokenKey(token: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('assetlab-mcp-access-token-api-key-v1'),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function sealApiKey(apiKey: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await tokenKey(token),
    new TextEncoder().encode(apiKey)
  )
  const combined = new Uint8Array(iv.length + ct.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ct), iv.length)
  return base64url(combined)
}

async function openApiKey(sealed: string, token: string): Promise<string> {
  const data = fromBase64url(sealed)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.slice(0, 12) },
    await tokenKey(token),
    data.slice(12)
  )
  return new TextDecoder().decode(plain)
}

async function mintAccessToken(
  kv: KVNamespace,
  apiKey: string,
  scope: string,
  clientId: string | undefined
): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const token = ACCESS_TOKEN_PREFIX + base64url(bytes)
  const hash = await sha256Hex(token)
  const record: AccessTokenRecord = {
    api_key_enc: await sealApiKey(apiKey, token),
    scope,
    client_id: clientId,
    created_at: Date.now(),
  }
  await kv.put(TOKEN_KEY(hash), JSON.stringify(record), {
    expirationTtl: ACCESS_TOKEN_TTL_SECONDS,
  })
  return token
}

/**
 * Resolve a Bearer token presented to the MCP transport. Called once per
 * incoming request from the Worker.
 *
 * - `mcp_at_*` tokens are looked up in KV. Miss → `null` (Worker returns 401).
 * - Legacy `al_live_*` / `al_test_*` tokens (issued before opaque-token swap
 *   or used by direct CLI integrations) pass through unchanged so the API
 *   gateway can validate them.
 * - Anything else is rejected (`null`) - the API gateway shouldn't see garbage.
 */
export async function resolveAccessToken(
  kv: KVNamespace,
  token: string
): Promise<{ apiKey: string; scope?: string; clientId?: string } | null> {
  if (!token) return null
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
    const hash = await sha256Hex(token)
    const raw = await kv.get(TOKEN_KEY(hash))
    if (!raw) return null
    try {
      const rec = JSON.parse(raw) as AccessTokenRecord
      const apiKey = rec.api_key_enc ? await openApiKey(rec.api_key_enc, token) : rec.api_key
      if (!apiKey) return null
      return { apiKey, scope: rec.scope, clientId: rec.client_id }
    } catch {
      return null
    }
  }
  if (token.startsWith('al_live_') || token.startsWith('al_test_')) {
    // Legacy passthrough - API gateway validates. Grace path for pre-swap sessions.
    return { apiKey: token }
  }
  return null
}

async function deleteAccessToken(kv: KVNamespace, token: string): Promise<void> {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return
  const hash = await sha256Hex(token)
  await kv.delete(TOKEN_KEY(hash))
}

// ── Redirect URI validation ──────────────────────────────────────────────────
//
// RFC 8252 §7.3: allow loopback http for native apps; everything else must be
// https. Reject anything that could exfiltrate the auth code via a non-HTTP
// transport (javascript:, data:, file:, ws://, etc.).

function isValidRedirectUri(uri: string): boolean {
  if (typeof uri !== 'string' || uri.length > 2000) return false
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  if (parsed.protocol === 'http:') {
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]'
    )
  }
  return false
}

// ── CORS ─────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set([
  'https://claude.ai',
  'https://chat.openai.com',
  'https://chatgpt.com',
])

export function corsHeaders(request: Request): Record<string, string> {
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

function json(
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

// ── Discovery endpoints ─────────────────────────────────────────────────────

export function protectedResourceMetadata(origin: string, request: Request): Response {
  const resource = origin.endsWith('/') ? origin : `${origin}/`
  return json(
    {
      resource,
      authorization_servers: [origin],
    },
    200,
    {},
    request
  )
}

export function authServerMetadata(origin: string, request: Request): Response {
  return json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      scopes_supported: ['claudeai', 'mcp'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    },
    200,
    {},
    request
  )
}

// ── Dynamic client registration (RFC 7591) ──────────────────────────────────

export async function handleRegister(request: Request, kv: KVNamespace): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return json(
      { error: 'invalid_client_metadata', error_description: 'Body must be valid JSON' },
      400
    )
  }

  const uris = body.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0) {
    return json(
      {
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must be a non-empty array',
      },
      400
    )
  }
  if (uris.length > 10) {
    return json(
      { error: 'invalid_redirect_uri', error_description: 'Too many redirect_uris (max 10)' },
      400
    )
  }
  for (const u of uris) {
    if (!isValidRedirectUri(u as string)) {
      return json(
        {
          error: 'invalid_redirect_uri',
          error_description:
            'All redirect_uris must use https:// (http:// is only allowed for localhost loopback)',
        },
        400
      )
    }
  }

  const name =
    typeof body.client_name === 'string' && body.client_name.trim().length > 0
      ? body.client_name.trim().slice(0, 200)
      : 'MCP Client'

  // Scope is stored as-is (≤200 chars). The /authorize and /token endpoints
  // intersect requested scope with the supported set at issue time.
  const rawScope = typeof body.scope === 'string' && body.scope.length <= 200 ? body.scope : 'mcp'

  const clientId = crypto.randomUUID()
  const regTokenBytes = crypto.getRandomValues(new Uint8Array(32))
  const regToken = base64url(regTokenBytes)
  const regTokenHash = await sha256Hex(regToken)

  const client: OAuthClient = {
    client_id: clientId,
    client_name: name,
    redirect_uris: uris as string[],
    scope: rawScope,
    registration_access_token_hash: regTokenHash,
    created_at: Date.now(),
  }
  await putClient(kv, client)

  const origin = new URL(request.url).origin
  return json(
    {
      client_id: clientId,
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: rawScope,
      registration_access_token: regToken,
      registration_client_uri: `${origin}/oauth/register/${clientId}`,
    },
    201
  )
}

// ── Authenticated client deletion (RFC 7592) ────────────────────────────────

export async function handleDelete(
  request: Request,
  kv: KVNamespace,
  clientId: string
): Promise<Response> {
  const auth = request.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) {
    return json(
      { error: 'invalid_token', error_description: 'Registration access token required' },
      401,
      { 'WWW-Authenticate': 'Bearer' }
    )
  }
  const token = auth.slice(7).trim()
  const client = await getClient(kv, clientId)
  // Return 401 (not 404) for unknown client_ids so we don't leak which IDs exist.
  if (!token || !client) {
    return json(
      { error: 'invalid_token', error_description: 'Invalid registration access token' },
      401
    )
  }
  const providedHash = await sha256Hex(token)
  if (!safeEqual(providedHash, client.registration_access_token_hash)) {
    return json(
      { error: 'invalid_token', error_description: 'Invalid registration access token' },
      401
    )
  }
  await deleteClient(kv, clientId)
  return new Response(null, { status: 204 })
}

// ── Authorization endpoint ──────────────────────────────────────────────────

export async function handleAuthorizeGet(request: Request, kv: KVNamespace): Promise<Response> {
  const url = new URL(request.url)
  const clientId = url.searchParams.get('client_id') ?? ''
  const redirectUri = url.searchParams.get('redirect_uri') ?? ''
  const responseType = url.searchParams.get('response_type') ?? 'code'
  const codeChallenge = url.searchParams.get('code_challenge') ?? ''
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? ''
  const scope = url.searchParams.get('scope') ?? ''
  const state = url.searchParams.get('state') ?? ''

  if (responseType !== 'code') {
    return errorPage(
      `Unsupported response_type "${responseType}". Only the authorization code flow is supported.`,
      400
    )
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return errorPage(
      'This server requires PKCE: code_challenge and code_challenge_method=S256 are mandatory.',
      400
    )
  }
  if (!clientId) {
    return errorPage('Missing client_id.', 400)
  }
  const client = await getClient(kv, clientId)
  if (!client) {
    return errorPage('Unknown client_id. Re-register the application and try again.', 400)
  }
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return errorPage('redirect_uri does not match any URI registered for this client.', 400)
  }

  let redirectHost = ''
  try {
    redirectHost = new URL(redirectUri).host
  } catch {
    redirectHost = ''
  }

  return renderConsentPage({
    clientName: client.client_name,
    redirectHost,
    state,
    redirectUri,
    codeChallenge,
    clientId,
    scope,
  })
}

export async function handleAuthorizePost(
  request: Request,
  env: { OAUTH_SECRET: string; OAUTH_CLIENTS: KVNamespace }
): Promise<Response> {
  const form = await request.formData()
  const apiKey = (form.get('api_key') as string)?.trim()
  const state = (form.get('state') as string) ?? ''
  const redirectUri = (form.get('redirect_uri') as string) ?? ''
  const codeChallenge = (form.get('code_challenge') as string) ?? ''
  const clientId = (form.get('client_id') as string) ?? ''
  const scope = (form.get('scope') as string) ?? ''

  if (!apiKey) return errorPage('API key is required.', 400)
  if (!clientId) return errorPage('Missing client_id.', 400)
  if (!codeChallenge) return errorPage('Missing PKCE code_challenge.', 400)

  // Re-validate against KV - guards against tampering with hidden form fields.
  const client = await getClient(env.OAUTH_CLIENTS, clientId)
  if (!client) return errorPage('Unknown client_id.', 400)
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return errorPage('redirect_uri does not match any URI registered for this client.', 400)
  }

  const payload: CodePayload = {
    apiKey,
    codeChallenge,
    redirectUri,
    scope,
    clientId,
    exp: Date.now() + 600_000, // 10 minutes
  }
  const code = await encrypt(JSON.stringify(payload), env.OAUTH_SECRET)

  const target = new URL(redirectUri)
  target.searchParams.set('code', code)
  if (state) target.searchParams.set('state', state)
  return Response.redirect(target.toString(), 302)
}

// ── Token endpoint ──────────────────────────────────────────────────────────

async function issueTokens(
  apiKey: string,
  scope: string,
  clientId: string | undefined,
  env: { OAUTH_SECRET: string; OAUTH_CLIENTS: KVNamespace }
): Promise<Response> {
  const effectiveScope = scope || 'mcp'
  const accessToken = await mintAccessToken(env.OAUTH_CLIENTS, apiKey, effectiveScope, clientId)

  const refreshPayload: RefreshPayload = {
    apiKey,
    scope: effectiveScope,
    clientId,
    type: 'refresh',
  }
  const refreshToken = await encrypt(JSON.stringify(refreshPayload), env.OAUTH_SECRET)

  return json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: effectiveScope,
    refresh_token: refreshToken,
  })
}

export async function handleToken(
  request: Request,
  env: { OAUTH_SECRET: string; OAUTH_CLIENTS: KVNamespace }
): Promise<Response> {
  let params: URLSearchParams
  const ct = request.headers.get('Content-Type') ?? ''
  if (ct.includes('application/json')) {
    const body = (await request.json()) as Record<string, string>
    params = new URLSearchParams(body)
  } else {
    params = new URLSearchParams(await request.text())
  }

  const grantType = params.get('grant_type')
  const requestClientId = params.get('client_id') ?? ''

  // ── Refresh token grant ──────────────────────────────────────────────────
  if (grantType === 'refresh_token') {
    const refreshToken = params.get('refresh_token')
    if (!refreshToken) {
      return json({ error: 'invalid_request', error_description: 'Missing refresh_token' }, 400)
    }

    let payload: RefreshPayload
    try {
      payload = JSON.parse(await decrypt(refreshToken, env.OAUTH_SECRET))
    } catch (err) {
      console.log('[token] refresh decrypt failed:', err instanceof Error ? err.message : err)
      return json({ error: 'invalid_grant', error_description: 'Invalid refresh token' }, 400)
    }
    if (payload.type !== 'refresh') {
      return json({ error: 'invalid_grant', error_description: 'Invalid refresh token' }, 400)
    }

    // Refresh tokens minted before this rewrite have no clientId - accept them
    // so existing Claude.ai / ChatGPT sessions survive the deploy. New tokens
    // always carry clientId and are validated against KV.
    if (payload.clientId) {
      const client = await getClient(env.OAUTH_CLIENTS, payload.clientId)
      if (!client) {
        return json(
          { error: 'invalid_grant', error_description: 'Client no longer registered' },
          400
        )
      }
    }

    return issueTokens(payload.apiKey, payload.scope, payload.clientId, env)
  }

  // ── Authorization code grant ─────────────────────────────────────────────
  if (grantType && grantType !== 'authorization_code') {
    return json(
      {
        error: 'unsupported_grant_type',
        error_description: `Unsupported grant_type "${grantType}"`,
      },
      400
    )
  }

  const code = params.get('code')
  const codeVerifier = params.get('code_verifier')
  const redirectUri = params.get('redirect_uri') ?? ''

  if (!code) return json({ error: 'invalid_request', error_description: 'Missing code' }, 400)
  if (!codeVerifier) {
    return json(
      { error: 'invalid_request', error_description: 'Missing code_verifier (PKCE is required)' },
      400
    )
  }
  // F-017 - RFC 6749 §3.2.1: public clients MUST send client_id on /token.
  if (!requestClientId) {
    return json({ error: 'invalid_request', error_description: 'Missing client_id' }, 400)
  }

  let payload: CodePayload
  try {
    payload = JSON.parse(await decrypt(code, env.OAUTH_SECRET))
  } catch (err) {
    console.log('[token] decrypt failed:', err instanceof Error ? err.message : err)
    return json({ error: 'invalid_grant', error_description: 'Invalid or expired code' }, 400)
  }

  if (Date.now() > payload.exp) {
    return json({ error: 'invalid_grant', error_description: 'Code expired' }, 400)
  }
  if (redirectUri && payload.redirectUri !== redirectUri) {
    return json({ error: 'invalid_grant', error_description: 'Redirect URI mismatch' }, 400)
  }
  if (requestClientId !== payload.clientId) {
    return json({ error: 'invalid_client', error_description: 'client_id mismatch' }, 400)
  }

  // F-015 - RFC 6749 §4.1.2: authorization codes MUST be single-use. Hash of
  // the raw code (not the code itself) is stored so the KV value isn't a
  // credential. Sentinel TTL matches the code's remaining lifetime.
  const codeHash = await sha256Hex(code)
  if (await env.OAUTH_CLIENTS.get(CONSUMED_CODE_KEY(codeHash))) {
    return json(
      { error: 'invalid_grant', error_description: 'Authorization code already used' },
      400
    )
  }

  const client = await getClient(env.OAUTH_CLIENTS, payload.clientId)
  if (!client) {
    return json({ error: 'invalid_client', error_description: 'Unknown client' }, 401)
  }
  if (!client.redirect_uris.includes(payload.redirectUri)) {
    return json(
      { error: 'invalid_grant', error_description: 'Redirect URI no longer registered' },
      400
    )
  }

  // PKCE verification - mandatory.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  const expected = base64url(digest)
  if (!safeEqual(expected, payload.codeChallenge)) {
    return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
  }

  // Mark code consumed before issuing tokens. KV expirationTtl is in seconds
  // and clamped at 60s minimum by Cloudflare.
  const remainingTtl = Math.max(60, Math.ceil((payload.exp - Date.now()) / 1000))
  await env.OAUTH_CLIENTS.put(CONSUMED_CODE_KEY(codeHash), '1', {
    expirationTtl: remainingTtl,
  })

  return issueTokens(payload.apiKey, payload.scope, payload.clientId, env)
}

// ── Token revocation (RFC 7009) ─────────────────────────────────────────────

/**
 * POST /oauth/revoke - revoke an opaque access token.
 *
 * Refresh tokens are encrypted blobs (not KV-backed), so per-token refresh
 * revocation is not supported in this iteration; rotating the underlying
 * AssetLab API key in Settings is the way to fully terminate a session.
 *
 * Per RFC 7009 §2.2 we return 200 for unknown tokens too - clients shouldn't
 * be able to probe token validity via this endpoint.
 */
export async function handleRevoke(
  request: Request,
  env: { OAUTH_CLIENTS: KVNamespace }
): Promise<Response> {
  let params: URLSearchParams
  const ct = request.headers.get('Content-Type') ?? ''
  try {
    if (ct.includes('application/json')) {
      const body = (await request.json()) as Record<string, string>
      params = new URLSearchParams(body)
    } else {
      params = new URLSearchParams(await request.text())
    }
  } catch {
    return json({ error: 'invalid_request', error_description: 'Malformed body' }, 400)
  }

  const token = params.get('token') ?? ''
  if (!token) {
    return json({ error: 'invalid_request', error_description: 'Missing token' }, 400)
  }

  // Best-effort: only opaque access tokens are revocable here. The 200 is
  // returned regardless to avoid leaking which tokens exist.
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
    await deleteAccessToken(env.OAUTH_CLIENTS, token)
  }
  return new Response(null, { status: 200 })
}

// ── Consent page rendering ──────────────────────────────────────────────────

interface ConsentPageData {
  clientName: string
  redirectHost: string
  state: string
  redirectUri: string
  codeChallenge: string
  clientId: string
  scope: string
}

/**
 * The mark from `public/uploads/logo.svg` in the SPA, inlined because the Worker
 * serves no static assets. Keep the circles in sync with that file.
 */
const LOGO_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 292.3 292.3" aria-hidden="true">
      <g transform="translate(95.414,86.487)">
        <circle fill="#45c28b" cx="-74.77" cy="-51.34" r="20"/>
        <circle fill="#45c28b" cx="-74.53" cy="1.19" r="20"/>
        <circle fill="#45c28b" cx="-22.24" cy="-28.91" r="20"/>
        <circle fill="#fbd04e" cx="-74.67" cy="56.37" r="20"/>
        <circle fill="#fbd04e" cx="-74.58" cy="120.34" r="20"/>
        <circle fill="#fbd04e" cx="-74.49" cy="172.05" r="20"/>
        <circle fill="#fbd04e" cx="-23.77" cy="26.56" r="20"/>
        <circle fill="#fbd04e" cx="22.72" cy="-7.36" r="15"/>
        <circle fill="#fbd04e" cx="-21.38" cy="89.52" r="17"/>
        <circle fill="#fbd04e" cx="30.77" cy="51.30" r="20"/>
        <circle fill="#fbd04e" cx="-21.89" cy="159.66" r="17"/>
        <circle fill="#fbd04e" cx="22.92" cy="173.41" r="15"/>
        <circle fill="#fbd04e" cx="35.15" cy="119.00" r="20"/>
        <circle fill="#fbd04e" cx="79.51" cy="79.64" r="15"/>
        <circle fill="#f78265" cx="72.59" cy="161.68" r="20"/>
        <circle fill="#f78265" cx="110.66" cy="131.00" r="12"/>
        <circle fill="#f78265" cx="121.37" cy="86.82" r="12"/>
        <circle fill="#f78265" cx="155.50" cy="110.89" r="15"/>
        <circle fill="#f78265" cx="136.27" cy="172.43" r="15"/>
        <circle fill="#f78265" cx="182.53" cy="154.52" r="15"/>
      </g>
    </svg>`

const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Lexend:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>`

/**
 * Mirrors the SPA sign-in screen: `pages/Login.tsx` (shell + BackgroundGrid),
 * `components/shared/Logo.tsx` (wordmark) and `components/auth/ClerkLoginForm.tsx`
 * (card, label, input, button, footer). Values are literal rather than tokenised
 * because the Worker ships no Tailwind - when the login screen changes, change this.
 */
const SHELL_CSS = `*{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Inter',system-ui,sans-serif;background:rgb(3,6,22);color:#fff;
         min-height:100vh;display:flex;flex-direction:column}
    .grid-base{position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.04;
      background-image:linear-gradient(rgba(255,255,255,.4) 1px,transparent 1px),
                        linear-gradient(90deg,rgba(255,255,255,.4) 1px,transparent 1px);
      background-size:60px 60px;
      -webkit-mask-image:radial-gradient(ellipse 60% 60% at 50% 50%,black 0%,transparent 100%);
      mask-image:radial-gradient(ellipse 60% 60% at 50% 50%,black 0%,transparent 100%)}
    .grid-glow{position:fixed;inset:0;pointer-events:none;z-index:0;
      background-image:linear-gradient(rgba(106,208,157,.3) 1px,transparent 1px),
                        linear-gradient(90deg,rgba(106,208,157,.3) 1px,transparent 1px);
      background-size:60px 60px;transition:opacity .3s;
      -webkit-mask-image:radial-gradient(circle 120px at -999px -999px,black 0%,transparent 100%);
      mask-image:radial-gradient(circle 120px at -999px -999px,black 0%,transparent 100%)}
    header{position:relative;z-index:10;padding:1rem 1.5rem;display:flex;align-items:center}
    main{flex:1;display:flex;align-items:center;justify-content:center;padding:1rem;
         position:relative;z-index:10}
    .shell{width:100%;max-width:28rem}
    .brand{display:flex;align-items:center;gap:.75rem}
    .brand svg{width:2.25rem;height:2.25rem;flex-shrink:0}
    .brand-text{font-family:'Lexend',system-ui,sans-serif;font-weight:300;font-size:1.5rem}
    .brand-text .lab{color:#45c28b}
    .brand-lg{justify-content:center;margin-bottom:1.5rem}
    .brand-lg svg{width:3rem;height:3rem}
    .brand-lg .brand-text{font-size:1.8rem}
    .card{background:transparent;backdrop-filter:blur(4px);border-radius:1rem;
          border:1px solid rgba(255,255,255,.2);width:100%}
    .card-header{padding:1.5rem}
    .card-content{padding:0 1.5rem 1.5rem}
    .card-desc{color:#d1d5db;font-size:.875rem;font-weight:400;text-align:center;
               margin-top:.25rem;line-height:1.5}
    .card-desc strong{color:#fff;font-weight:500}
    .card-footer{margin-top:1.5rem;padding-top:1.5rem;border-top:1px solid rgba(255,255,255,.2);
                 text-align:center}
    .card-footer p{font-size:.875rem;color:#9ca3af}
    .copyright{font-size:.75rem;color:#6b7280;margin-top:1rem}`

const FORM_CSS = `label{display:flex;align-items:center;gap:.5rem;color:#e5e7eb;font-weight:500;
          font-size:.75rem;line-height:1;margin-bottom:.5rem}
    @media (min-width:768px){label{font-size:.875rem}}
    label svg{width:1rem;height:1rem;color:#9ca3af;flex-shrink:0}
    input[type="password"]{display:flex;height:2.5rem;width:100%;padding:.5rem .75rem;
          background:transparent;border:1px solid rgba(255,255,255,.2);border-radius:.375rem;
          font-family:inherit;font-size:.875rem;color:#fff;outline:none;
          transition:border-color .2s}
    input[type="password"]::placeholder{color:#6b7280}
    input[type="password"]:focus-visible{border-width:2px;border-color:rgb(106,208,157);
          padding:calc(.5rem - 1px) calc(.75rem - 1px)}
    .help{color:#6b7280;font-size:.75rem;margin-top:.375rem}
    button{display:inline-flex;align-items:center;justify-content:center;width:100%;
           height:2.5rem;margin-top:1.5rem;padding:0 1rem;background:rgb(106,208,157);
           color:rgb(3,6,22);border:2px solid hsl(150 60% 28%);border-radius:.5rem;
           font-family:inherit;font-size:.875rem;font-weight:500;cursor:pointer;
           transition:background-color .15s}
    button:hover{background:rgb(86,188,137)}
    button:disabled{opacity:.5;cursor:not-allowed;pointer-events:none}
    .host{color:#e5e7eb;font-weight:500}`

/** Tracks the cursor for the grid glow, matching BackgroundGrid's mousemove effect. */
const GRID_GLOW_SCRIPT = `(function(){
      var g=document.getElementById('gridGlow');
      document.addEventListener('mousemove',function(e){
        var m='radial-gradient(circle 120px at '+e.clientX+'px '+e.clientY+'px,black 0%,transparent 100%)';
        g.style.webkitMaskImage=m;g.style.maskImage=m;
      });
    })();`

// Inert, unlike the SPA's header logo: following a link from here abandons the
// authorization and loses the code challenge.
const BRAND_HEADER = `<header>
    <div class="brand">
      ${LOGO_MARK_SVG}
      <span class="brand-text">Asset<span class="lab">Lab</span></span>
    </div>
  </header>`

const BRAND_LOCKUP = `<div class="brand brand-lg">
        ${LOGO_MARK_SVG}
        <span class="brand-text">Asset<span class="lab">Lab</span></span>
      </div>`

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    },
  })
}

function renderConsentPage(data: ConsentPageData): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Connect to AssetLab</title>
  ${FONT_LINKS}
  <style>
    ${SHELL_CSS}
    ${FORM_CSS}
  </style>
</head>
<body>
  <div class="grid-base"></div>
  <div class="grid-glow" id="gridGlow"></div>
  ${BRAND_HEADER}
  <main>
    <div class="shell">
      <div class="card">
        <div class="card-header">
          ${BRAND_LOCKUP}
          <h1 class="card-desc"><strong>${escapeHtml(data.clientName)}</strong> wants to access your AssetLab workspace via MCP.</h1>
        </div>
        <div class="card-content">
          <form method="POST" action="/authorize" id="form">
            <input type="hidden" name="state" value="${escapeHtml(data.state)}"/>
            <input type="hidden" name="redirect_uri" value="${escapeHtml(data.redirectUri)}"/>
            <input type="hidden" name="code_challenge" value="${escapeHtml(data.codeChallenge)}"/>
            <input type="hidden" name="client_id" value="${escapeHtml(data.clientId)}"/>
            <input type="hidden" name="scope" value="${escapeHtml(data.scope)}"/>
            <label for="api_key">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
              API Key
            </label>
            <input type="password" id="api_key" name="api_key" placeholder="al_live_..." required
                   pattern="al_(live|test)_.+" title="Must start with al_live_ or al_test_"/>
            <p class="help">Find this in AssetLab → Settings → API Keys</p>
            <button type="submit" id="btn">Authorize</button>
          </form>
          <div class="card-footer">
            <p>After authorizing you'll be redirected to <span class="host">${escapeHtml(data.redirectHost)}</span>.</p>
            <div class="copyright">© ${new Date().getUTCFullYear()} AssetLab. All rights reserved.</div>
          </div>
        </div>
      </div>
    </div>
  </main>
  <script>
    document.getElementById('form').addEventListener('submit',()=>{
      document.getElementById('btn').disabled=true;
      document.getElementById('btn').textContent='Connecting…';
    });
    ${GRID_GLOW_SCRIPT}
  </script>
</body>
</html>`

  return htmlResponse(html, 200)
}

function errorPage(message: string, status = 400): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Authorization error</title>
  ${FONT_LINKS}
  <style>
    ${SHELL_CSS}
    .alert{padding:.75rem;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);
           border-radius:.375rem;color:#f87171;font-size:.875rem;line-height:1.5}
  </style>
</head>
<body>
  <div class="grid-base"></div>
  <div class="grid-glow" id="gridGlow"></div>
  ${BRAND_HEADER}
  <main>
    <div class="shell">
      <div class="card">
        <div class="card-header">
          ${BRAND_LOCKUP}
          <h1 class="card-desc">Authorization failed</h1>
        </div>
        <div class="card-content">
          <p class="alert">${escapeHtml(message)}</p>
          <div class="card-footer">
            <p>Close this window and start the connection again from your MCP client.</p>
          </div>
        </div>
      </div>
    </div>
  </main>
  <script>
    ${GRID_GLOW_SCRIPT}
  </script>
</body>
</html>`
  return htmlResponse(html, status)
}

// ── Utility ─────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
