// OAuth dynamic client registration security tests (RFC 7591/7592).
// These cover the F-005 / F-007 pentest fixes.

import { beforeEach, describe, expect, it } from 'vitest'
import { handleDelete, handleRegister } from '../../src/oauth.js'
import { FakeKV } from '../fixtures/fake-kv.js'

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, init)
}

function jsonBody(obj: unknown): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(obj),
    headers: { 'Content-Type': 'application/json' },
  }
}

describe('OAuth /oauth/register — input validation (F-007 hardening)', () => {
  let kv: FakeKV
  beforeEach(() => {
    kv = new FakeKV()
  })

  it('rejects non-array redirect_uris', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({ redirect_uris: 'https://x.com/cb' })
      ),
      kv
    )
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('invalid_redirect_uri')
  })

  it('rejects empty redirect_uris array', async () => {
    const r = await handleRegister(
      req('https://mcp.example.com/oauth/register', jsonBody({ redirect_uris: [] })),
      kv
    )
    expect(r.status).toBe(400)
  })

  it('rejects javascript: redirect URI (XSS vector)', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['javascript:alert(document.cookie)'],
        })
      ),
      kv
    )
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string; error_description: string }
    expect(body.error).toBe('invalid_redirect_uri')
  })

  it('rejects data: redirect URI (code exfiltration vector)', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['data:text/html,<script>fetch(location)</script>'],
        })
      ),
      kv
    )
    expect(r.status).toBe(400)
  })

  it('rejects file: redirect URI', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['file:///etc/passwd'],
        })
      ),
      kv
    )
    expect(r.status).toBe(400)
  })

  it('rejects ws:// redirect URI', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['ws://attacker.evil/sink'],
        })
      ),
      kv
    )
    expect(r.status).toBe(400)
  })

  it('rejects http:// for non-loopback hostnames', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['http://attacker.evil/cb'],
        })
      ),
      kv
    )
    expect(r.status).toBe(400)
  })

  it('accepts http://localhost for native apps (RFC 8252)', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['http://localhost:8080/cb'],
        })
      ),
      kv
    )
    expect(r.status).toBe(201)
  })

  it('accepts http://127.0.0.1 loopback', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['http://127.0.0.1:65000/cb'],
        })
      ),
      kv
    )
    expect(r.status).toBe(201)
  })

  it('accepts http://[::1] IPv6 loopback', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['http://[::1]/cb'],
        })
      ),
      kv
    )
    expect(r.status).toBe(201)
  })

  it('rejects more than 10 redirect_uris (cap enforced)', async () => {
    const uris = Array.from({ length: 11 }, (_, i) => `https://x${i}.example.com/cb`)
    const r = await handleRegister(
      req('https://mcp.example.com/oauth/register', jsonBody({ redirect_uris: uris })),
      kv
    )
    expect(r.status).toBe(400)
  })

  it('rejects an oversized 5000-char URI', async () => {
    const big = 'https://' + 'a'.repeat(5000) + '.com/cb'
    const r = await handleRegister(
      req('https://mcp.example.com/oauth/register', jsonBody({ redirect_uris: [big] })),
      kv
    )
    expect(r.status).toBe(400)
  })

  it('rejects malformed JSON body', async () => {
    const r = await handleRegister(
      req('https://mcp.example.com/oauth/register', {
        method: 'POST',
        body: 'not json {{{',
        headers: { 'Content-Type': 'application/json' },
      }),
      kv
    )
    expect(r.status).toBe(400)
  })

  it('persists a client record on success', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
          client_name: 'Claude.ai',
        })
      ),
      kv
    )
    expect(r.status).toBe(201)
    const body = (await r.json()) as { client_id: string; registration_access_token: string }
    expect(body.client_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(kv._size()).toBe(1)
    expect(kv._keys()[0]).toMatch(/^oauth_client:/)
  })

  it('returns registration_access_token + registration_client_uri (RFC 7591)', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        })
      ),
      kv
    )
    const body = (await r.json()) as {
      registration_access_token: string
      registration_client_uri: string
    }
    expect(body.registration_access_token).toBeTruthy()
    expect(body.registration_access_token.length).toBeGreaterThan(20)
    expect(body.registration_client_uri).toMatch(
      /^https:\/\/mcp\.example\.com\/oauth\/register\/[0-9a-f-]{36}$/
    )
  })

  it('stores SHA-256 hash of token, not the token itself', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['https://claude.ai/cb'],
        })
      ),
      kv
    )
    const body = (await r.json()) as { registration_access_token: string }
    const raw = kv._raw(kv._keys()[0]) as string
    expect(raw).not.toContain(body.registration_access_token)
    // 64-char hex hash should be present
    expect(raw).toMatch(/[0-9a-f]{64}/)
  })

  it('clamps client_name to 200 chars', async () => {
    const longName = 'A'.repeat(5000)
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['https://claude.ai/cb'],
          client_name: longName,
        })
      ),
      kv
    )
    const body = (await r.json()) as { client_name: string }
    expect(body.client_name.length).toBe(200)
  })

  it('falls back to default client_name when empty', async () => {
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['https://claude.ai/cb'],
          client_name: '   ',
        })
      ),
      kv
    )
    const body = (await r.json()) as { client_name: string }
    expect(body.client_name).toBe('MCP Client')
  })
})

describe('OAuth DELETE /oauth/register/{id} (RFC 7592)', () => {
  let kv: FakeKV
  let clientId = ''
  let regToken = ''

  beforeEach(async () => {
    kv = new FakeKV()
    const r = await handleRegister(
      req(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['https://claude.ai/cb'],
        })
      ),
      kv
    )
    const body = (await r.json()) as { client_id: string; registration_access_token: string }
    clientId = body.client_id
    regToken = body.registration_access_token
  })

  it('401 without Authorization header (F-007 fix)', async () => {
    const r = await handleDelete(
      req(`https://mcp.example.com/oauth/register/${clientId}`, { method: 'DELETE' }),
      kv,
      clientId
    )
    expect(r.status).toBe(401)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('invalid_token')
  })

  it('401 with wrong Authorization scheme', async () => {
    const r = await handleDelete(
      req(`https://mcp.example.com/oauth/register/${clientId}`, {
        method: 'DELETE',
        headers: { Authorization: `Basic ${btoa('user:pass')}` },
      }),
      kv,
      clientId
    )
    expect(r.status).toBe(401)
  })

  it('401 with wrong Bearer token (constant-time compare)', async () => {
    const r = await handleDelete(
      req(`https://mcp.example.com/oauth/register/${clientId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer not-a-real-token' },
      }),
      kv,
      clientId
    )
    expect(r.status).toBe(401)
    expect(kv._size()).toBe(1) // Client must still exist after a failed delete.
  })

  it('401 (not 404) for unknown client_id to avoid enumeration', async () => {
    const r = await handleDelete(
      req('https://mcp.example.com/oauth/register/00000000-0000-0000-0000-000000000000', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${regToken}` },
      }),
      kv,
      '00000000-0000-0000-0000-000000000000'
    )
    expect(r.status).toBe(401)
  })

  it('204 with correct registration_access_token, record removed', async () => {
    const r = await handleDelete(
      req(`https://mcp.example.com/oauth/register/${clientId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${regToken}` },
      }),
      kv,
      clientId
    )
    expect(r.status).toBe(204)
    expect(kv._size()).toBe(0)
  })

  it('uses constant-time comparison (timing-attack resistant)', async () => {
    // A 1-char-off token must yield identical timing — we cannot directly assert
    // that, but we CAN assert correctness: identical-length wrong token rejects.
    const r = await handleDelete(
      req(`https://mcp.example.com/oauth/register/${clientId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${'X'.repeat(regToken.length)}` },
      }),
      kv,
      clientId
    )
    expect(r.status).toBe(401)
  })
})
