# MCP Server Tests

Hermetic, parallel-safe Vitest suite for `@assetlab/mcp-server`. No live network,
no real KV, no real AssetLab tenants — everything runs against in-memory fakes.

## Running

```bash
# Install vitest first (added to devDependencies)
npm install

# One-shot
npm test

# Watch mode (re-run on save)
npm run test:watch

# Coverage (V8 + HTML report under coverage/)
npm run test:coverage
```

## Layout

```
tests/
├── fixtures/                     # Hermetic test infrastructure (no network)
│   ├── factories.ts              # Deterministic seeded data factories
│   ├── fake-fetch.ts             # globalThis.fetch replacement w/ call log
│   ├── fake-kv.ts                # In-memory Cloudflare KVNamespace fake
│   └── tool-harness.ts           # FakeMcpServer capturing tool registrations
│
├── unit/                         # Pure module-level tests
│   └── client.test.ts            # AssetLabClient: URL/auth/error mapping
│
├── integration/                  # Tools-through-fake-server tests
│   ├── tools-business-logic.test.ts   # Happy paths across every domain
│   └── edge-cases.test.ts             # Unicode, boundaries, concurrency
│
├── security/                     # Highest-priority pre-go-live checks
│   ├── multi-tenant.test.ts            # Bearer isolation, no cross-tenant leak
│   ├── input-validation.test.ts        # Zod rejection paths + SQLi payloads
│   ├── oauth-registration.test.ts      # RFC 7591 + redirect-URI hardening
│   ├── oauth-authorize.test.ts         # Consent page XSS/clickjacking guards
│   └── oauth-token.test.ts             # PKCE S256, code reuse, refresh grant
│
├── reliability/                  # Failure mode coverage
│   └── bulk-and-failures.test.ts       # 207, network errors, idempotency
│
├── contract/                     # Tool catalog shape conformance
│   └── tool-shapes.test.ts             # Every tool has desc, schema, handler
│
└── regression/                   # Bug-specific tests, named after finding IDs
    └── pentest-fixes.test.ts           # F-002, F-005, F-006, F-007, F-010, F-011
```

## What each suite covers

### unit/
Direct exercise of `AssetLabClient` without going through MCP. Verifies:
- URL composition (apiUrl normalization, /v1 prefix, trailing-slash handling)
- Authorization header always present
- Status-code → error message mapping (401/403/404/429/500)
- `listAll()` auto-pagination
- Bulk endpoint status handling (200/201/207/400-with-summary)
- `loadConfig()` env var parsing

### integration/
Tools registered against a `FakeMcpServer`. Each test mocks the API gateway via
`installFetchFake()` and invokes the tool through the same code path the real
transport uses. Verifies:
- Tool registration produces the expected catalog
- Filter parameters forward to the URL correctly
- POST/PATCH/DELETE bodies are shaped correctly
- `update_*` strips undefined fields (only changed fields are sent)
- Response wrapping per MCP spec (`{ content: [{ type: 'text', text: '...' }] }`)
- Unicode names round-trip
- Boundary conditions (1/100 items for bulk, 0/100/200/500 char strings)

### security/
**Highest priority** — these run before each release.

- **multi-tenant**: Two clients in the same process never bleed Bearer tokens.
  UUID-spoofing GET/UPDATE/DELETE returns 404 (RLS enforcement at gateway).
  `tenant_id` in payload is forwarded unmodified (gateway-side override).

- **input-validation**: Every zod schema's rejection path:
  - Non-UUID id rejected
  - per_page > 1000 rejected (DoS guard)
  - Invalid enum values rejected (risk_factor, priority, status, work-order type)
  - Numeric ranges (condition_score 0-100, purchase_cost ≥ 0)
  - String length caps (name ≤ 500, search ≤ 200, image_url ≤ 2000)
  - SQL-injection / JNDI / path-traversal payloads pass through as text
    (gateway is the escaping boundary — not us)
  - Bulk caps (max 100 items, min 1 item, closed resource enum)
  - Upload bucket enum is closed

- **oauth-registration** (F-007): Redirect URI scheme allowlist.
  Reject `javascript:`, `data:`, `file:`, `ws://`, etc.
  Loopback (`localhost` / `127.0.0.1`) exception for native apps.
  Client name length-clamped and HTML-escaped before persistence.
  Registration access token stored as hash, not plaintext.

- **oauth-authorize** (F-005, F-010): Consent page emits `X-Frame-Options: DENY`
  and `Content-Security-Policy: frame-ancestors 'none'`. Reflected XSS via
  `client_name` / `state` blocked. Rejects implicit grant, requires PKCE S256.

- **oauth-token**: Mints opaque `mcp_at_*` tokens. Rejects mismatched
  code_verifier, redirect_uri, client_id. Rejects unknown grant types.
  Refresh grant happy path + deleted-client revocation.

### reliability/
- 207 Multi-Status bulk responses surface per-item errors to the caller
- 400 with `summary` returns structured failure (not thrown)
- 400 without `summary` surfaces as MCP error
- 429 / 401 / 502 / fetch-rejection / malformed-JSON all surface cleanly
- Idempotent repeat calls produce identical wire requests

### contract/
- Every registered tool has non-empty `description`, valid zod schema, async handler
- Every primary resource has full CRUD surface (list/get/create/update/delete)
- Bulk and upload surfaces present
- SERVER_INSTRUCTIONS string is well-formed and references both hierarchies

### regression/
Named after the penetration-test finding IDs they guard:
- **F-002**: POST /mcp gated by Bearer (would-have caught the tool-catalog leak)
- **F-005 / F-005-P1**: Opaque `mcp_at_*` token resolution + legacy passthrough
- **F-006**: CORS allow-list (rejects unknown origins + subdomain spoofing)
- **F-007**: Redirect URI scheme allowlist
- **F-010**: Clickjacking headers + HTML escaping on consent page
- **F-011**: SERVER_INSTRUCTIONS prompt-injection shape
- Non-pentest: DEMAND → REACTIVE work-order rename, closed bulk-resource enum,
  closed upload-bucket enum, pagination boundary defaults

## How to add a new test

1. Pick the right directory (most new tests belong in `integration/` or `security/`).
2. Import the harness:
   ```ts
   import { FakeMcpServer, asMcpServer } from '../fixtures/tool-harness.js'
   import { installFetchFake } from '../fixtures/fake-fetch.js'
   import { AssetLabClient } from '../../src/client.js'
   import { registerTools } from '../../src/tools.js'
   import type { McpServer } from '@modelcontextprotocol/server'
   ```
3. In `beforeEach`, install the fetch fake and register tools.
4. Stub the gateway endpoint with `fx.on(method, pathname|regex, handler)`.
5. Invoke `server.call('tool_name', { ... })`.
6. Assert on either:
   - `fx.calls[0]` (request shape sent to the gateway)
   - `r.content[0].text` (response surfaced to the MCP client)
   - `r.isError` (error surface)
   - thrown `ZodError` (input validation rejection)

## Hermetic guarantees

- `globalThis.fetch` is replaced per-test by `installFetchFake()` and restored
  in `afterEach`. Any test that touches the real network is a bug.
- `FakeKV` is a per-test instance — never shared. TTLs use `.unref()` so they
  don't keep the test process alive.
- All UUIDs and tenant IDs come from `factories.ts` — deterministic, seeded by
  a process-local counter. No `Date.now()` / `Math.random()` leakage.
- Tests are isolated via `isolate: true` in `vitest.config.ts`.

## Known gaps (deliberate)

- We do not test the real `WebStandardStreamableHTTPServerTransport` — that's
  vendored from the MCP SDK and tested upstream. We exercise the worker's
  request-routing logic but stop before transport.handleRequest().
- We do not test against a real Cloudflare KV — `FakeKV` is sufficient because
  the surface we use is tiny (get/put/delete with TTL).
- We do not run against a real AssetLab gateway. The gateway has its own
  RLS-tested suite under `supabase/functions/api-gateway/`.
- No load testing here — see the gateway's perf benchmarks for that.
