// Hermetic factories for test data.
// No faker dependency to keep tests free of network/install footprint.
// All randomness is seeded.

let _counter = 0
function nextCount(): number {
  _counter += 1
  return _counter
}
export function resetCounters(): void {
  _counter = 0
}

export function uuid(seed: string | number = nextCount()): string {
  const s = String(seed).padEnd(32, '0')
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
  }
  const hex = (h.toString(16) + s.replace(/\D/g, '0')).padEnd(32, 'a').slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    '8' + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-')
}

export function apiKey(kind: 'live' | 'test' = 'live', seed = nextCount()): string {
  return `al_${kind}_tenant_${seed}_abc${seed}xyz`
}

export function tenantId(seed = nextCount()): string {
  return `org_${String(seed).padStart(8, '0')}`
}

export function asset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = uuid(`asset-${nextCount()}`)
  return {
    id,
    tenant_id: 'org_test_default',
    name: `Asset ${id.slice(0, 8)}`,
    asset_type_id: uuid(`asset-type-${id}`),
    site_id: uuid(`site-${id}`),
    building_id: uuid(`building-${id}`),
    location_id: uuid(`location-${id}`),
    risk_factor: 'MEDIUM',
    condition_score: 75,
    purchase_cost: 10000,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function workOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = uuid(`wo-${nextCount()}`)
  return {
    id,
    tenant_id: 'org_test_default',
    title: `Work order ${id.slice(0, 8)}`,
    status: 'NEW',
    priority: 'MEDIUM',
    type: 'REACTIVE',
    site_id: uuid(`site-${id}`),
    building_id: uuid(`building-${id}`),
    asset_id: uuid(`asset-${id}`),
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function site(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = uuid(`site-${nextCount()}`)
  return {
    id,
    tenant_id: 'org_test_default',
    name: `Site ${id.slice(0, 8)}`,
    city: 'Vancouver',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = uuid(`project-${nextCount()}`)
  return {
    id,
    tenant_id: 'org_test_default',
    name: `Project ${id.slice(0, 8)}`,
    type: 'capital',
    health_status: 'on_track',
    budget: 100000,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function paginated<T>(
  data: T[],
  pagination: Partial<{ page: number; per_page: number; total: number; total_pages: number }> = {}
) {
  return {
    data,
    pagination: { page: 1, per_page: 1000, total: data.length, total_pages: 1, ...pagination },
  }
}

export function single<T>(record: T): { data: T } {
  return { data: record }
}
