// OAuth /authorize endpoint security tests.
// Covers F-007 (consent page redirect_uri allow-list) and F-010 (anti-framing headers).

import { beforeEach, describe, expect, it } from 'vitest'
import { handleAuthorizeGet, handleAuthorizePost, handleRegister } from '../../src/oauth.js'
import { FakeKV } from '../fixtures/fake-kv.js'

function jsonBody(obj: unknown): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(obj),
    headers: { 'Content-Type': 'application/json' },
  }
}

async function makeClient(
  kv: FakeKV,
  redirectUris: string[] = ['https://claude.ai/api/mcp/auth_callback']
): Promise<string> {
  const r = await handleRegister(
    new Request(
      'https://mcp.example.com/oauth/register',
      jsonBody({
        redirect_uris: redirectUris,
        client_name: 'TestClient',
      })
    ),
    kv
  )
  const body = (await r.json()) as { client_id: string }
  return body.client_id
}

describe('OAuth /authorize GET — consent page validation', () => {
  let kv: FakeKV
  let clientId = ''
  beforeEach(async () => {
    kv = new FakeKV()
    clientId = await makeClient(kv)
  })

  it('rejects response_type other than "code" (no implicit grant)', async () => {
    const url = new URL('https://mcp.example.com/authorize')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback')
    url.searchParams.set('response_type', 'token')
    url.searchParams.set('code_challenge', 'x'.repeat(43))
    url.searchParams.set('code_challenge_method', 'S256')
    const r = await handleAuthorizeGet(new Request(url.toString()), kv)
    expect(r.status).toBe(400)
  })

  it('requires PKCE code_challenge', async () => {
    const url = new URL('https://mcp.example.com/authorize')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback')
    url.searchParams.set('response_type', 'code')
    // omit code_challenge
    const r = await handleAuthorizeGet(new Request(url.toString()), kv)
    expect(r.status).toBe(400)
  })

  it('rejects code_challenge_method=plain (S256 only)', async () => {
    const url = new URL('https://mcp.example.com/authorize')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge', 'x'.repeat(43))
    url.searchParams.set('code_challenge_method', 'plain')
    const r = await handleAuthorizeGet(new Request(url.toString()), kv)
    expect(r.status).toBe(400)
  })

  it('rejects unknown client_id', async () => {
    const url = new URL('https://mcp.example.com/authorize')
    url.searchParams.set('client_id', '00000000-0000-0000-0000-000000000000')
    url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge', 'x'.repeat(43))
    url.searchParams.set('code_challenge_method', 'S256')
    const r = await handleAuthorizeGet(new Request(url.toString()), kv)
    expect(r.status).toBe(400)
  })

  it('rejects redirect_uri not exact-matching a registered URI (open-redirect blocker)', async () => {
    const url = new URL('https://mcp.example.com/authorize')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', 'https://attacker.evil/cb')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge', 'x'.repeat(43))
    url.searchParams.set('code_challenge_method', 'S256')
    const r = await handleAuthorizeGet(new Request(url.toString()), kv)
    expect(r.status).toBe(400)
  })

  it('rejects appended-path redirect_uri', async () => {
    const url = new URL('https://mcp.example.com/authorize')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback/../../evil')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge', 'x'.repeat(43))
    url.searchParams.set('code_challenge_method', 'S256')
    const r = await handleAuthorizeGet(new Request(url.toString()), kv)
    expect(r.status).toBe(400)
  })

  it('emits X-Frame-Options: DENY on consent page (F-010 anti-framing fix)', async () => {
    const url = new URL('https://mcp.example.com/authorize')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge', 'x'.repeat(43))
    url.searchParams.set('code_challenge_method', 'S256')
    const r = await handleAuthorizeGet(new Request(url.toString()), kv)
    expect(r.status).toBe(200)
    expect(r.headers.get('X-Frame-Options')).toBe('DENY')
    expect(r.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  })

  it('emits anti-framing headers on the error page too', async () => {
    const url = new URL('https://mcp.example.com/authorize')
    url.searchParams.set('client_id', 'unknown')
    url.searchParams.set('redirect_uri', 'https://x/')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge', 'x'.repeat(43))
    url.searchParams.set('code_challenge_method', 'S256')
    const r = await handleAuthorizeGet(new Request(url.toString()), kv)
    expect(r.headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('embeds the actual registered client_name in consent page (not a hardcoded label)', async () => {
    const url = new URL('https://mcp.example.com/authorize')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge', 'x'.repeat(43))
    url.searchParams.set('code_challenge_method', 'S256')
    const r = await handleAuthorizeGet(new Request(url.toString()), kv)
    const html = await r.text()
    expect(html).toContain('TestClient')
  })

  it('escapes HTML in client_name to avoid stored XSS', async () => {
    const kv2 = new FakeKV()
    const evilName = '<script>alert(1)</script>'
    const reg = await handleRegister(
      new Request(
        'https://mcp.example.com/oauth/register',
        jsonBody({
          redirect_uris: ['https://claude.ai/cb'],
          client_name: evilName,
        })
      ),
      kv2
    )
    const { client_id } = (await reg.json()) as { client_id: string }
    const url = new URL('https://mcp.example.com/authorize')
    url.searchParams.set('client_id', client_id)
    url.searchParams.set('redirect_uri', 'https://claude.ai/cb')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge', 'x'.repeat(43))
    url.searchParams.set('code_challenge_method', 'S256')
    const r = await handleAuthorizeGet(new Request(url.toString()), kv2)
    const html = await r.text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes HTML in state parameter (no reflected XSS via hidden field)', async () => {
    const url = new URL('https://mcp.example.com/authorize')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge', 'x'.repeat(43))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', '"><script>x()</script>')
    const r = await handleAuthorizeGet(new Request(url.toString()), kv)
    const html = await r.text()
    expect(html).not.toContain('"><script>x()</script>')
  })
})

describe('OAuth /authorize POST — code minting', () => {
  let kv: FakeKV
  let clientId = ''
  beforeEach(async () => {
    kv = new FakeKV()
    clientId = await makeClient(kv)
  })

  function form(fields: Record<string, string>): Request {
    const body = new URLSearchParams(fields).toString()
    return new Request('https://mcp.example.com/authorize', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
  }

  const env = () => ({ OAUTH_SECRET: 'a'.repeat(32), OAUTH_CLIENTS: kv })

  it('rejects missing api_key', async () => {
    const r = await handleAuthorizePost(
      form({
        client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'x'.repeat(43),
      }),
      env()
    )
    expect(r.status).toBe(400)
  })

  it('rejects missing client_id', async () => {
    const r = await handleAuthorizePost(
      form({
        api_key: 'al_live_xxx',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'x'.repeat(43),
      }),
      env()
    )
    expect(r.status).toBe(400)
  })

  it('rejects missing code_challenge (PKCE mandatory)', async () => {
    const r = await handleAuthorizePost(
      form({
        api_key: 'al_live_xxx',
        client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      }),
      env()
    )
    expect(r.status).toBe(400)
  })

  it('rejects tampered redirect_uri (defense in depth, even though hidden)', async () => {
    const r = await handleAuthorizePost(
      form({
        api_key: 'al_live_xxx',
        client_id: clientId,
        redirect_uri: 'https://attacker.evil/cb',
        code_challenge: 'x'.repeat(43),
      }),
      env()
    )
    expect(r.status).toBe(400)
  })

  it('rejects tampered client_id', async () => {
    const r = await handleAuthorizePost(
      form({
        api_key: 'al_live_xxx',
        client_id: '00000000-0000-0000-0000-000000000000',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'x'.repeat(43),
      }),
      env()
    )
    expect(r.status).toBe(400)
  })

  it('issues 302 with code+state on the redirect_uri target on success', async () => {
    const r = await handleAuthorizePost(
      form({
        api_key: 'al_live_xxx',
        client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'x'.repeat(43),
        state: 'abc-state',
      }),
      env()
    )
    expect(r.status).toBe(302)
    const loc = r.headers.get('Location') || ''
    const target = new URL(loc)
    expect(target.hostname).toBe('claude.ai')
    expect(target.searchParams.get('code')).toBeTruthy()
    expect(target.searchParams.get('state')).toBe('abc-state')
  })

  it('does not echo state if not provided', async () => {
    const r = await handleAuthorizePost(
      form({
        api_key: 'al_live_xxx',
        client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'x'.repeat(43),
      }),
      env()
    )
    const loc = r.headers.get('Location') || ''
    const target = new URL(loc)
    expect(target.searchParams.get('state')).toBeNull()
  })
})
