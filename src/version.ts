/**
 * The single source of truth for the version this server reports.
 *
 * F-154: there used to be three, and none of them agreed — `package.json` at 2.0.1, the Worker's
 * `SERVER_INFO` hardcoded at 1.3.0, and the stdio server at 1.0.0. The one every connected MCP
 * client displays was the Worker's, so the only version a customer or a support conversation could
 * observe was the one tracking nothing. That is why npm sitting two releases behind went unnoticed
 * for a fortnight.
 *
 * `rootDir` is `./src`, so importing ../package.json is not available. Instead this constant is the
 * only literal, and `tests/version.test.ts` fails if it drifts from `package.json`. Bump both
 * together — the test tells you if you forget.
 */
export const VERSION = '3.0.2'
