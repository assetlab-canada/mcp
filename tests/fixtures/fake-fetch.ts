// Fake fetch for AssetLabClient.
//
// Records each request and returns a programmable response. Tests describe
// the API gateway's behavior; we never reach Supabase.
//
// Usage:
//   const fx = installFetchFake()
//   fx.handle('GET', '/v1/assets', (req) => fx.json({ data: [...], pagination: {...} }))
//   ... run code under test ...
//   expect(fx.calls).toHaveLength(1)
//   fx.restore()

export type FakeResponseInit = { status?: number; body?: unknown; headers?: Record<string, string> }
export type Handler = (req: {
  url: URL
  method: string
  body: unknown
  headers: Headers
}) => FakeResponseInit | Promise<FakeResponseInit>

export interface CallRecord {
  method: string
  url: string
  pathname: string
  body: unknown
  headers: Record<string, string>
}

export class FetchFake {
  calls: CallRecord[] = []
  private handlers: Array<{ method: string; pathname: string | RegExp; handler: Handler }> = []
  private originalFetch: typeof globalThis.fetch | undefined

  install(): void {
    this.originalFetch = globalThis.fetch
    globalThis.fetch = this.handle.bind(this) as typeof globalThis.fetch
  }

  restore(): void {
    if (this.originalFetch) globalThis.fetch = this.originalFetch
    this.originalFetch = undefined
    this.calls = []
    this.handlers = []
  }

  on(method: string, pathname: string | RegExp, handler: Handler): this {
    this.handlers.push({ method: method.toUpperCase(), pathname, handler })
    return this
  }

  json(body: unknown, status = 200): FakeResponseInit {
    return { status, body, headers: { 'content-type': 'application/json' } }
  }

  error(status: number, message: string): FakeResponseInit {
    return { status, body: { error: message }, headers: { 'content-type': 'application/json' } }
  }

  private async handle(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    )
    const method = (
      init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET')
    ).toUpperCase()
    let bodyText: string | undefined
    if (init?.body) bodyText = typeof init.body === 'string' ? init.body : String(init.body)
    let body: unknown
    if (bodyText) {
      try {
        body = JSON.parse(bodyText)
      } catch {
        body = bodyText
      }
    }
    const headers: Record<string, string> = {}
    const rawHeaders = new Headers(init?.headers ?? {})
    rawHeaders.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })

    this.calls.push({ method, url: url.toString(), pathname: url.pathname, body, headers })

    for (const h of this.handlers) {
      if (h.method !== method) continue
      const ok =
        typeof h.pathname === 'string' ? h.pathname === url.pathname : h.pathname.test(url.pathname)
      if (!ok) continue
      const r = await h.handler({ url, method, body, headers: rawHeaders })
      const status = r.status ?? 200
      const init: ResponseInit = { status, headers: r.headers ?? {} }
      const responseBody =
        typeof r.body === 'string' || r.body === undefined
          ? (r.body as string | undefined)
          : JSON.stringify(r.body)
      return new Response(responseBody, init)
    }
    return new Response(JSON.stringify({ error: `No mock for ${method} ${url.pathname}` }), {
      status: 599,
      headers: { 'content-type': 'application/json' },
    })
  }
}

export function installFetchFake(): FetchFake {
  const fake = new FetchFake()
  fake.install()
  return fake
}
