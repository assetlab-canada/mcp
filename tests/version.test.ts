import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.js'

// F-154. Three hand-maintained version numbers that never agreed: package.json at 2.0.1, the
// Worker's SERVER_INFO at 1.3.0, the stdio server at 1.0.0. The Worker's is the one Claude.ai and
// ChatGPT display, so the only observable version was the meaningless one — which is how npm ended
// up two releases behind, including a breaking one, without anyone noticing.
//
// There is one literal now and this pins it. Free: no network, no registry, pure string compare.
// The npm-registry half of F-154 cannot live here — a published version is not a property of this
// repo — and belongs on the nightly cron or the release checklist.

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
) as { version: string }

describe('version reporting (F-154)', () => {
  it('VERSION matches package.json', () => {
    expect(VERSION).toBe(pkg.version)
  })

  it('is a plain semver triple, so a client can compare it', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
