/**
 * A local sample so the review flow can be tried without an agent. The
 * backend stores it with `sample: true` and never sends anything for it.
 */

export const SAMPLE_PLAN_TITLE = "Add rate limiting to the public API";

export const SAMPLE_PLAN_MARKDOWN = `# Add rate limiting to the public API

## Goal

Protect the public API from abusive clients without affecting normal usage. Limits apply per API key and are visible to clients through response headers.

## Approach

1. **Token bucket per key.** Store buckets in Redis with a 60-second window and a burst allowance of 2x the steady rate.
2. **Middleware.** Add a \`rateLimit\` middleware in front of every \`/v1\` route. It reads the key from the \`Authorization\` header and rejects with \`429 Too Many Requests\` when the bucket is empty.
3. **Headers.** Every response carries \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`, and \`X-RateLimit-Reset\`.
4. **Configuration.** Default to 600 requests per minute. Allow per-key overrides in the \`api_keys\` table.

## Files

- \`src/middleware/rate-limit.ts\` (new)
- \`src/server.ts\` (register the middleware)
- \`src/db/migrations/0042_api_key_limits.sql\` (new column)
- \`docs/api/limits.md\` (new)

## Testing

- Unit tests for the bucket math, including refill after the window.
- An integration test that sends 601 requests in a minute and expects one \`429\`.

## Open questions

- Should internal services bypass the limit, or get a separate, higher tier?
- Do we need a dashboard, or are logs enough for the first release?
`;

export const SAMPLE_PLAN_REVISION = `# Add rate limiting to the public API

## Goal

Protect the public API from abusive clients without affecting normal usage. Limits apply per API key and are visible to clients through response headers.

## Approach

1. **Sliding window per key.** Store request timestamps in a Redis sorted set with a 60-second window. This avoids the burst spikes a token bucket allows at window edges.
2. **Middleware.** Add a \`rateLimit\` middleware in front of every \`/v1\` route. It reads the key from the \`Authorization\` header and rejects with \`429 Too Many Requests\` plus a \`Retry-After\` header when the window is full.
3. **Headers.** Every response carries \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`, and \`X-RateLimit-Reset\`.
4. **Configuration.** Default to 600 requests per minute. Allow per-key overrides in the \`api_keys\` table.
5. **Internal bypass.** Requests carrying a valid internal service token skip the limit entirely.

## Files

- \`src/middleware/rate-limit.ts\` (new)
- \`src/server.ts\` (register the middleware)
- \`src/db/migrations/0042_api_key_limits.sql\` (new column)
- \`docs/api/limits.md\` (new)

## Testing

- Unit tests for the window math, including expiry of old timestamps.
- An integration test that sends 601 requests in a minute and expects one \`429\` with \`Retry-After\`.
- A test that an internal token is never limited.

## Open questions

- Do we need a dashboard, or are logs enough for the first release?
`;
