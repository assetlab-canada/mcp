// OAuth /token endpoint — PKCE verification, code/refresh exchange.
// Covers F-005 (PKCE strictness) and F-005-P1 (opaque access tokens).

import { beforeEach, describe, expect, it } from 'vitest'
import {
  handleAuthorizePost,
  handleRegister,
  handleRevoke,
  handleToken,
  resolveAccessToken,
} from '../../src/oauth.js'
import { FakeKV } from '../fixtures/fake-kv.js'

function jsonBody(obj: unknown): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(obj),
    headers: { 'Content-Type': 'application/json' },
  }
}

function tokenReq(params: Record<string, string>): Request {
  const body = new URLSearchParams(params).toString()
  return new Request('https://mcp.example.com/token', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
}

async function pkce(verifier: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return Buffer.from(new Uint8Array(buf))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function setupClientAndCode(
  kv: FakeKV,
  secret: string,
  opts: {
    apiKey?: string
    verifier?: string
    redirectUri?: string
    scope?: string
  } = {}
): Promise<{ clientId: string; code: string; verifier: string; redirectUri: string }> {
  const redirectUri = opts.redirectUri ?? 'https://claude.ai/api/mcp/auth_callback'
  const reg = await handleRegister(
    new Request(
      'https://mcp.example.com/oauth/register',
      jsonBody({
        redirect_uris: [redirectUri],
      })
    ),
    kv
  )
  const { client_id } = (await reg.json()) as { client_id: string }

  const verifier = opts.verifier ?? 'verifier-' + 'a'.repeat(60)
  const challenge = await pkce(verifier)
  const form = new URLSearchParams({
    api_key: opts.apiKey ?? 'al_live_test_key',
    client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    scope: opts.scope ?? '',
  })
  const r = await handleAuthorizePost(
    new Request('https://mcp.example.com/authorize', {
      method: 'POST',
      body: form.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }),
    { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
  )
  const loc = r.headers.get('Location') as string
  const code = new URL(loc).searchParams.get('code') as string
  return { clientId: client_id, code, verifier, redirectUri }
}

describe('OAuth /token — authorization_code grant', () => {
  const secret = 'test-secret-' + 'a'.repeat(32)
  let kv: FakeKV
  beforeEach(() => {
    kv = new FakeKV()
  })

  it('issues opaque mcp_at_* access token on valid exchange (F-005-P1)', async () => {
    const { clientId, code, verifier, redirectUri } = await setupClientAndCode(kv, secret)
    const r = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      token_type: string
    }
    expect(body.access_token).toMatch(/^mcp_at_/)
    expect(body.token_type).toBe('Bearer')
    expect(body.expires_in).toBeGreaterThanOrEqual(3600)
    expect(body.refresh_token).toBeTruthy()
    // Access token must not be the raw API key.
    expect(body.access_token).not.toBe('al_live_test_key')
  })

  it('rejects when code_verifier is missing (PKCE mandatory)', async () => {
    const { clientId, code, redirectUri } = await setupClientAndCode(kv, secret)
    const r = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('invalid_request')
  })

  it('rejects wrong code_verifier (PKCE proof)', async () => {
    const { clientId, code, redirectUri } = await setupClientAndCode(kv, secret)
    const r = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'wrong-verifier-' + 'z'.repeat(60),
        redirect_uri: redirectUri,
        client_id: clientId,
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('invalid_grant')
  })

  it('rejects mismatched redirect_uri at token exchange', async () => {
    const { clientId, code, verifier } = await setupClientAndCode(kv, secret)
    const r = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'https://attacker.evil/cb',
        client_id: clientId,
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(400)
  })

  it('rejects mismatched client_id at token exchange', async () => {
    const { code, verifier, redirectUri } = await setupClientAndCode(kv, secret)
    const r = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: '11111111-2222-3333-4444-555555555555',
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('invalid_client')
  })

  it('rejects tampered (different secret) auth code', async () => {
    const { clientId, verifier, redirectUri } = await setupClientAndCode(kv, secret)
    // Generate a code with a different secret then try to redeem with the real env
    const bad = await setupClientAndCode(kv, 'different-secret-' + 'b'.repeat(32))
    const r = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code: bad.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(400)
  })

  it('rejects unsupported grant_type', async () => {
    const r = await handleToken(
      tokenReq({
        grant_type: 'password',
        code: 'x',
        code_verifier: 'y',
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('unsupported_grant_type')
  })

  it('rejects missing code parameter', async () => {
    const r = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code_verifier: 'x',
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(400)
  })

  it('issued access_token resolves back to the original API key', async () => {
    const { clientId, code, verifier, redirectUri } = await setupClientAndCode(kv, secret, {
      apiKey: 'al_live_specific_key_xyz',
    })
    const r = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    const { access_token } = (await r.json()) as { access_token: string }
    const resolved = await resolveAccessToken(kv, access_token)
    expect(resolved?.apiKey).toBe('al_live_specific_key_xyz')
  })

  it('JSON content-type request bodies are accepted', async () => {
    const { clientId, code, verifier, redirectUri } = await setupClientAndCode(kv, secret)
    const r = await handleToken(
      new Request('https://mcp.example.com/token', {
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          client_id: clientId,
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(200)
  })

  // F-017 — RFC 6749 §3.2.1: public clients MUST send client_id on /token.
  it('rejects authorization_code exchange when client_id is missing (F-017)', async () => {
    const { code, verifier, redirectUri } = await setupClientAndCode(kv, secret)
    const r = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        // client_id intentionally omitted
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string; error_description: string }
    expect(body.error).toBe('invalid_request')
    expect(body.error_description).toMatch(/client_id/i)
  })

  // F-017 — empty-string client_id is treated the same as missing.
  it('rejects authorization_code exchange when client_id is empty (F-017)', async () => {
    const { code, verifier, redirectUri } = await setupClientAndCode(kv, secret)
    const r = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: '',
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe('invalid_request')
  })

  // F-015 — RFC 6749 §4.1.2: authorization codes MUST be single-use.
  it('rejects a second exchange of the same authorization code (F-015 replay)', async () => {
    const { clientId, code, verifier, redirectUri } = await setupClientAndCode(kv, secret)
    const env = { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    const params = {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: clientId,
    }

    const first = await handleToken(tokenReq(params), env)
    expect(first.status).toBe(200)

    const second = await handleToken(tokenReq(params), env)
    expect(second.status).toBe(400)
    const body = (await second.json()) as { error: string; error_description: string }
    expect(body.error).toBe('invalid_grant')
    expect(body.error_description).toMatch(/already used/i)
  })

  // F-015 — replay must be detected even when other request params differ.
  it('rejects code replay even when redirect_uri/verifier are tweaked (F-015)', async () => {
    const { clientId, code, verifier, redirectUri } = await setupClientAndCode(kv, secret)
    const env = { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }

    const first = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
      }),
      env
    )
    expect(first.status).toBe(200)

    // Replay with a wrong verifier — must still fail (and not because of PKCE,
    // because the consumed sentinel is checked first; either way the attacker
    // cannot mint a second token).
    const second = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'different-verifier-' + 'q'.repeat(60),
        redirect_uri: redirectUri,
        client_id: clientId,
      }),
      env
    )
    expect(second.status).toBe(400)
  })

  // F-015 — the first (legitimate) exchange writes the sentinel into KV.
  it('writes a consumed_code:* sentinel after a successful exchange (F-015)', async () => {
    const { clientId, code, verifier, redirectUri } = await setupClientAndCode(kv, secret)
    await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )

    const consumedKeys = kv._keys().filter(k => k.startsWith('consumed_code:'))
    expect(consumedKeys).toHaveLength(1)
  })
})

describe('OAuth /token — refresh_token grant', () => {
  const secret = 'test-secret-' + 'a'.repeat(32)
  let kv: FakeKV
  let refreshToken = ''
  let clientId = ''
  beforeEach(async () => {
    kv = new FakeKV()
    const setup = await setupClientAndCode(kv, secret)
    clientId = setup.clientId
    const r = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code: setup.code,
        code_verifier: setup.verifier,
        redirect_uri: setup.redirectUri,
        client_id: setup.clientId,
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    refreshToken = ((await r.json()) as { refresh_token: string }).refresh_token
  })

  it('mints a new access_token on refresh', async () => {
    const r = await handleToken(
      tokenReq({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(200)
    const body = (await r.json()) as { access_token: string }
    expect(body.access_token).toMatch(/^mcp_at_/)
  })

  it('rejects malformed refresh_token', async () => {
    const r = await handleToken(
      tokenReq({
        grant_type: 'refresh_token',
        refresh_token: 'not-a-real-refresh-token',
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('invalid_grant')
  })

  it('rejects missing refresh_token', async () => {
    const r = await handleToken(tokenReq({ grant_type: 'refresh_token' }), {
      OAUTH_SECRET: secret,
      OAUTH_CLIENTS: kv,
    })
    expect(r.status).toBe(400)
  })

  it('rejects refresh when the underlying client was deleted', async () => {
    // Delete the client from KV
    await kv.delete(`oauth_client:${clientId}`)
    const r = await handleToken(
      tokenReq({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('invalid_grant')
  })
})

describe('resolveAccessToken (Bearer token resolution)', () => {
  let kv: FakeKV
  beforeEach(() => {
    kv = new FakeKV()
  })

  it('returns null for empty token', async () => {
    expect(await resolveAccessToken(kv, '')).toBeNull()
  })

  it('returns null for unknown mcp_at_* token (forces re-auth instead of leaking)', async () => {
    const r = await resolveAccessToken(kv, 'mcp_at_' + 'x'.repeat(43))
    expect(r).toBeNull()
  })

  it('passes through al_live_* legacy keys (backward compat)', async () => {
    const r = await resolveAccessToken(kv, 'al_live_abc123')
    expect(r?.apiKey).toBe('al_live_abc123')
  })

  it('passes through al_test_* legacy keys', async () => {
    const r = await resolveAccessToken(kv, 'al_test_xyz')
    expect(r?.apiKey).toBe('al_test_xyz')
  })

  it('rejects unrecognized token prefix (garbage)', async () => {
    expect(await resolveAccessToken(kv, 'bearer-garbage-token')).toBeNull()
    expect(await resolveAccessToken(kv, 'sk-openai-xxxxxxxxx')).toBeNull()
  })
})

describe('OAuth /oauth/revoke (RFC 7009)', () => {
  const secret = 'test-secret-' + 'a'.repeat(32)
  let kv: FakeKV
  beforeEach(() => {
    kv = new FakeKV()
  })

  it('returns 200 even for unknown tokens (no probing)', async () => {
    const r = await handleRevoke(tokenReq({ token: 'mcp_at_' + 'x'.repeat(43) }), {
      OAUTH_CLIENTS: kv,
    })
    expect(r.status).toBe(200)
  })

  it('400 when token is missing', async () => {
    const r = await handleRevoke(tokenReq({}), { OAUTH_CLIENTS: kv })
    expect(r.status).toBe(400)
  })

  it('actually deletes the KV record for known mcp_at_* tokens', async () => {
    // Mint a token by going through the full flow
    const setup = await setupClientAndCode(kv, secret)
    const tokR = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code: setup.code,
        code_verifier: setup.verifier,
        redirect_uri: setup.redirectUri,
        client_id: setup.clientId,
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    const { access_token } = (await tokR.json()) as { access_token: string }
    expect(await resolveAccessToken(kv, access_token)).not.toBeNull()
    await handleRevoke(tokenReq({ token: access_token }), { OAUTH_CLIENTS: kv })
    expect(await resolveAccessToken(kv, access_token)).toBeNull()
  })
})

describe('access-token records at rest in KV (F-250)', () => {
  const secret = 'test-secret-' + 'a'.repeat(32)
  const apiKey = 'al_live_f250_sensitive_key_0123456789' // gitleaks:allow - fake key
  let kv: FakeKV
  beforeEach(() => {
    kv = new FakeKV()
  })

  async function mint(): Promise<string> {
    const setup = await setupClientAndCode(kv, secret, { apiKey })
    const r = await handleToken(
      tokenReq({
        grant_type: 'authorization_code',
        code: setup.code,
        code_verifier: setup.verifier,
        redirect_uri: setup.redirectUri,
        client_id: setup.clientId,
      }),
      { OAUTH_SECRET: secret, OAUTH_CLIENTS: kv }
    )
    return ((await r.json()) as { access_token: string }).access_token
  }

  function tokenRecordKey(): string {
    const keys = kv._keys().filter(k => k.startsWith('oauth_token:'))
    expect(keys).toHaveLength(1)
    return keys[0]
  }

  it('stores no part of the API key in plaintext', async () => {
    await mint()
    const raw = kv._raw(tokenRecordKey()) as string
    expect(raw).not.toContain(apiKey)
    expect(raw).not.toContain(apiKey.slice(8, 24))
    expect(JSON.parse(raw)).not.toHaveProperty('api_key')
  })

  it('a token minted from the encrypted record still resolves to the key', async () => {
    const token = await mint()
    expect((await resolveAccessToken(kv, token))?.apiKey).toBe(apiKey)
  })

  it('the record cannot be opened by a different token under the same KV key', async () => {
    const token = await mint()
    const key = tokenRecordKey()
    const raw = kv._raw(key) as string
    const other = 'mcp_at_' + 'y'.repeat(43)
    const otherHash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(other)))
    )
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    await kv.put(`oauth_token:${otherHash}`, raw)
    expect(await resolveAccessToken(kv, other)).toBeNull()
    expect((await resolveAccessToken(kv, token))?.apiKey).toBe(apiKey)
  })

  it('still resolves a pre-F-250 plaintext record until it expires', async () => {
    const token = 'mcp_at_' + 'z'.repeat(43)
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
    )
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    await kv.put(
      `oauth_token:${hash}`,
      JSON.stringify({ api_key: apiKey, scope: '', created_at: Date.now() })
    )
    expect((await resolveAccessToken(kv, token))?.apiKey).toBe(apiKey)
  })
})
