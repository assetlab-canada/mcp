/**
 * HTTP client for the AssetLab API Gateway.
 *
 * All requests go through the api-gateway edge function,
 * authenticated via Bearer API key.
 */

export interface AssetLabConfig {
  apiUrl: string
  apiKey: string
}

export interface PaginatedResponse<T = Record<string, unknown>> {
  data: T[]
  pagination: {
    page: number
    per_page: number
    total: number
    total_pages: number
  }
}

export interface SingleResponse<T = Record<string, unknown>> {
  data: T
}

export interface BulkItemResult {
  index: number
  success: boolean
  data?: Record<string, unknown>
  error?: string
  details?: Array<{ field: string; message: string }>
}

export interface BulkResponse {
  summary: { total: number; succeeded: number; failed: number }
  results: BulkItemResult[]
}

export class AssetLabClientError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'AssetLabClientError'
    this.status = status
  }
}

// F-016 - Identity-defining keys must come from the gateway's JWT-derived
// context, never from the caller. Stripping here is defense-in-depth: the
// gateway already overrides these from the verified Clerk claims, but a
// future endpoint or gateway misconfig shouldn't immediately turn into a
// tenant-isolation bypass.
const STRIP_KEYS = ['tenant_id', 'organization_id', 'org_id'] as const

function stripIdentityKeys<T extends Record<string, unknown>>(payload: T): T {
  let cleaned: T | undefined
  for (const k of STRIP_KEYS) {
    if (k in payload) {
      if (!cleaned) cleaned = { ...payload }
      delete cleaned[k]
    }
  }
  return cleaned ?? payload
}

// Supabase runs a function nearest the caller, which is in the US for most AI providers (F-249).
const GATEWAY_REGION = 'ca-central-1'

export class AssetLabClient {
  private baseUrl: string
  private apiKey: string

  constructor(config: AssetLabConfig) {
    // Ensure base URL ends without trailing slash and includes /v1
    let url = config.apiUrl.replace(/\/+$/, '')
    if (!url.endsWith('/v1')) {
      url += '/v1'
    }
    this.baseUrl = url
    this.apiKey = config.apiKey
  }

  async get<T = Record<string, unknown>>(
    path: string,
    params?: Record<string, string | number | undefined>
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, String(v))
        }
      }
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'x-region': GATEWAY_REGION,
        'Content-Type': 'application/json',
      },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      const message = (body as { error?: string }).error || `HTTP ${res.status}`

      // Map to user-friendly messages
      switch (res.status) {
        case 401:
          throw new AssetLabClientError(401, 'Authentication failed. Check your ASSETLAB_API_KEY.')
        case 403:
          throw new AssetLabClientError(
            403,
            message.includes('scope')
              ? message
              : message.includes('expired')
                ? 'API key has expired. Generate a new one in AssetLab Settings > API Keys.'
                : message
          )
        case 429:
          throw new AssetLabClientError(429, 'Rate limit exceeded. Wait a moment and try again.')
        case 404:
          throw new AssetLabClientError(404, message)
        default:
          throw new AssetLabClientError(res.status, message)
      }
    }

    return res.json() as Promise<T>
  }

  async list<T = Record<string, unknown>>(
    resource: string,
    params?: Record<string, string | number | undefined>
  ): Promise<PaginatedResponse<T>> {
    return this.get<PaginatedResponse<T>>(`/${resource}`, params)
  }

  /**
   * Fetch all pages of a paginated resource automatically.
   * Uses per_page=1000 to minimize round-trips, then follows
   * pagination until all rows are collected.
   */
  async listAll<T = Record<string, unknown>>(
    resource: string,
    params?: Record<string, string | number | undefined>
  ): Promise<{ data: T[]; total: number }> {
    const allData: T[] = []
    let page = 1
    const perPage = 1000

    while (true) {
      const result = await this.list<T>(resource, { ...params, page, per_page: perPage })
      allData.push(...result.data)

      if (page >= result.pagination.total_pages) break
      page++
    }

    return { data: allData, total: allData.length }
  }

  async getOne<T = Record<string, unknown>>(
    resource: string,
    id: string
  ): Promise<SingleResponse<T>> {
    return this.get<SingleResponse<T>>(`/${resource}/${id}`)
  }

  async post<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${path}`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'x-region': GATEWAY_REGION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      const message = (data as { error?: string }).error || `HTTP ${res.status}`

      switch (res.status) {
        case 401:
          throw new AssetLabClientError(401, 'Authentication failed. Check your ASSETLAB_API_KEY.')
        case 403:
          throw new AssetLabClientError(
            403,
            message.includes('scope')
              ? message
              : message.includes('expired')
                ? 'API key has expired. Generate a new one in AssetLab Settings > API Keys.'
                : message
          )
        case 429:
          throw new AssetLabClientError(429, 'Rate limit exceeded. Wait a moment and try again.')
        case 400:
          throw new AssetLabClientError(400, message)
        default:
          throw new AssetLabClientError(res.status, message)
      }
    }

    return res.json() as Promise<T>
  }

  async create<T = Record<string, unknown>>(
    resource: string,
    body: Record<string, unknown>
  ): Promise<SingleResponse<T>> {
    return this.post<SingleResponse<T>>(`/${resource}`, stripIdentityKeys(body))
  }

  async patch<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`

    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'x-region': GATEWAY_REGION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      const message = (data as { error?: string }).error || `HTTP ${res.status}`

      switch (res.status) {
        case 401:
          throw new AssetLabClientError(401, 'Authentication failed. Check your ASSETLAB_API_KEY.')
        case 403:
          throw new AssetLabClientError(
            403,
            message.includes('scope')
              ? message
              : message.includes('expired')
                ? 'API key has expired. Generate a new one in AssetLab Settings > API Keys.'
                : message
          )
        case 429:
          throw new AssetLabClientError(429, 'Rate limit exceeded. Wait a moment and try again.')
        case 400:
          throw new AssetLabClientError(400, message)
        case 404:
          throw new AssetLabClientError(404, message)
        default:
          throw new AssetLabClientError(res.status, message)
      }
    }

    return res.json() as Promise<T>
  }

  async update<T = Record<string, unknown>>(
    resource: string,
    id: string,
    body: Record<string, unknown>
  ): Promise<SingleResponse<T>> {
    return this.patch<SingleResponse<T>>(`/${resource}/${id}`, stripIdentityKeys(body))
  }

  private async fetchBulk(
    method: 'POST' | 'PATCH',
    path: string,
    items: Record<string, unknown>[]
  ): Promise<BulkResponse> {
    const url = `${this.baseUrl}${path}`

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'x-region': GATEWAY_REGION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(items),
    })

    // 200/201 = all succeeded, 207 = partial success, 400 = all failed (still structured)
    if (res.status === 200 || res.status === 201 || res.status === 207) {
      return res.json() as Promise<BulkResponse>
    }

    // 400 could be structured bulk response (all items failed) or a request-level error
    if (res.status === 400) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      if ((data as { summary?: unknown }).summary) return data as BulkResponse
      throw new AssetLabClientError(400, (data as { error?: string }).error || 'Bad request')
    }

    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    const message = (data as { error?: string }).error || `HTTP ${res.status}`
    switch (res.status) {
      case 401:
        throw new AssetLabClientError(401, 'Authentication failed. Check your ASSETLAB_API_KEY.')
      case 403:
        throw new AssetLabClientError(403, message)
      case 429:
        throw new AssetLabClientError(429, 'Rate limit exceeded. Wait a moment and try again.')
      default:
        throw new AssetLabClientError(res.status, message)
    }
  }

  async bulkCreate(resource: string, items: Record<string, unknown>[]): Promise<BulkResponse> {
    return this.fetchBulk('POST', `/${resource}/bulk`, items.map(stripIdentityKeys))
  }

  async bulkUpdate(resource: string, items: Record<string, unknown>[]): Promise<BulkResponse> {
    return this.fetchBulk('PATCH', `/${resource}/bulk`, items.map(stripIdentityKeys))
  }

  async del(path: string): Promise<{ success: boolean; message: string }> {
    const url = `${this.baseUrl}${path}`

    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'x-region': GATEWAY_REGION,
        'Content-Type': 'application/json',
      },
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      const message = (data as { error?: string }).error || `HTTP ${res.status}`

      switch (res.status) {
        case 401:
          throw new AssetLabClientError(401, 'Authentication failed. Check your ASSETLAB_API_KEY.')
        case 403:
          throw new AssetLabClientError(
            403,
            message.includes('scope')
              ? message
              : message.includes('expired')
                ? 'API key has expired. Generate a new one in AssetLab Settings > API Keys.'
                : message
          )
        case 429:
          throw new AssetLabClientError(429, 'Rate limit exceeded. Wait a moment and try again.')
        case 404:
          throw new AssetLabClientError(404, message)
        default:
          throw new AssetLabClientError(res.status, message)
      }
    }

    return res.json() as Promise<{ success: boolean; message: string }>
  }

  async remove(resource: string, id: string): Promise<{ success: boolean; message: string }> {
    return this.del(`/${resource}/${id}`)
  }
}

export function loadConfig(): AssetLabConfig {
  const apiKey = process.env.ASSETLAB_API_KEY
  if (!apiKey) {
    throw new Error(
      'ASSETLAB_API_KEY environment variable is required. ' +
        'Create an API key in AssetLab Settings > API Keys.'
    )
  }

  const apiUrl = process.env.ASSETLAB_API_URL
  if (!apiUrl) {
    throw new Error(
      'ASSETLAB_API_URL environment variable is required. ' +
        'Example: https://<project>.supabase.co/functions/v1/api-gateway'
    )
  }

  return { apiKey, apiUrl }
}
