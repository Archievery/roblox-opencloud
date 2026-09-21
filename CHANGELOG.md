# Changelog

## 0.1.0

Initial release.

- Typed client for 17 Roblox Open Cloud operations across users, groups, group join requests and
  universe user restrictions, plus a generic `request()` escape hatch for anything else.
- Credential providers: `apiKey`, `oauth` (with access-token caching, single-flight refresh and
  rotated-token persistence), a headroom-aware `pool`, and `custom`.
- Request queue with bounded concurrency, coalescing of identical in-flight reads, correct
  `Retry-After` handling, and exponential backoff when polling long-running operations.
- One `OpenCloudError` type covering all four of Roblox's error envelopes.
- Optional Hono server at the `/server` subpath for sharing one queue across services.
