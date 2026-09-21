# @minecraft2fun/roblox-opencloud

A typed Roblox Open Cloud client for Node, Bun and Deno, with request queueing, rate-limit
awareness, and OAuth tokens that refresh and rotate themselves.

```bash
npm install @minecraft2fun/roblox-opencloud
```

```ts
import { OpenCloudClient, apiKey } from "@minecraft2fun/roblox-opencloud";

const client = new OpenCloudClient({ credential: apiKey(process.env.ROBLOX_API_KEY!) });

const user = await client.getUser({ userId: "1" });
const group = await client.getGroup({ groupId: "7" });
```

## Why this and not `fetch`

Most of the work in talking to Open Cloud is not the request:

- **Credentials.** API keys are easy. OAuth is not: refresh tokens are single-use and rotate on
  every refresh, so two concurrent refreshes invalidate each other. This library caches the
  access token, single-flights the refresh, and hands you the rotated refresh token to persist.
- **Rate limits.** It tracks headroom per credential from Roblox's response headers, honours
  `Retry-After` correctly, bounds concurrency, and can spread load across a pool of credentials.
- **Long-running operations.** Thumbnail generation returns an `Operation` resource you must
  poll at a relative path that is easy to join wrongly. This polls it for you, with exponential
  backoff.
- **Four different error shapes.** Open Cloud v2, the legacy ingress, the OAuth token endpoint
  and operation-level failures all report errors differently, and `code` is a string in one and
  an integer in two others. You get one `OpenCloudError`.

## Credentials

Every credential is a `Credential`, so they compose.

```ts
import { apiKey, oauth, pool, custom } from "@minecraft2fun/roblox-opencloud";

apiKey("your-open-cloud-key");

oauth({
    clientId, clientSecret,
    refreshToken,                       // rotates on every refresh
    onTokensRefreshed: ({ refreshToken }) => db.save(refreshToken),
});

// Prefers whichever member has the most observed headroom. A pool is itself a credential,
// so pools nest.
pool([apiKey(keyA), apiKey(keyB)]);

// For platforms that mint tokens elsewhere.
custom("my-id", async () => fetchTokenFromVault());
```

**`onTokensRefreshed` is not optional in practice.** Roblox invalidates a refresh token the
moment you use it and returns a new one. If you do not persist the new one, your next refresh
fails with `invalid_grant` and the user has to authorize again. It is awaited before the
triggering request is sent; a rejection is logged, not thrown.

`credential` itself *is* optional — a few Roblox endpoints are served anonymously.

## Operations

| Method | Endpoint | Scope |
|---|---|---|
| `getUser` | `GET /cloud/v2/users/{userId}` | none (`user.advanced:read` adds `idVerified`) |
| `getUsersByUsername` | `POST users.roblox.com/v1/usernames/users` | none — anonymous |
| `generateUserThumbnail` | `GET /cloud/v2/users/{userId}:generateThumbnail` | none |
| `getThumbnailOperation` | `GET /cloud/v2/users/{userId}/operations/{operationId}` | none |
| `getGroup` | `GET /cloud/v2/groups/{groupId}` | none |
| `getGroupRole` | `GET /cloud/v2/groups/{groupId}/roles/{roleId}` | `group:read` |
| `listGroupRoles` | `GET .../roles` | `group:read` |
| `listGroupMemberships` | `GET .../memberships` | none |
| `assignGroupRole` | `POST .../memberships/{userId}:assignRole` | `group:write` |
| `unassignGroupRole` | `POST .../memberships/{userId}:unassignRole` | `group:write` |
| `listJoinRequests` | `GET .../join-requests` | `group:read` |
| `acceptJoinRequest` | `POST .../join-requests/{userId}:accept` | `group:write` |
| `declineJoinRequest` | `POST .../join-requests/{userId}:decline` | `group:write` |
| `listUserRestrictions` | `GET /cloud/v2/universes/{universeId}/user-restrictions` | `universe.user-restriction:read` |
| `getUserRestriction` | `GET .../user-restrictions/{userId}` | `universe.user-restriction:read` |
| `setUserRestriction` | `PATCH .../user-restrictions/{userId}` | `universe.user-restriction:write` |
| `listUserRestrictionLogs` | `GET .../user-restrictions:listLogs` | `universe.user-restriction:read` |

### Pagination

Roblox caps page sizes differently per endpoint — **20** for roles and join requests, **100** for
memberships and restrictions — and *clamps* an oversized request rather than rejecting it, so
asking for 100 roles silently gives you 20 and a group with 21 roles loses one with no error.
This library rejects an out-of-range `maxPageSize` locally, and gives you an iterator:

```ts
import { listGroupRoles } from "@minecraft2fun/roblox-opencloud";

for await (const role of client.paginate(listGroupRoles, { groupId })) {
    console.log(role.rank, role.displayName);
}
```

### Bans (user restrictions)

There is no create and no delete: one `PATCH` bans, edits and unbans.

```ts
// Temporary ban.
await client.setUserRestriction({
    universeId, userId,
    restriction: { active: true, durationSeconds: 3600, displayReason: "Cheating" },
});

// Permanent ban - omit durationSeconds. Roblox rejects a negative duration with a 400,
// despite a widely-circulated forum answer saying to send -1.
await client.setUserRestriction({ universeId, userId, restriction: { active: true } });

// Unban.
await client.setUserRestriction({ universeId, userId, restriction: { active: false } });
```

Pass `placeId` to scope any of these to one place. Note a place-level unban cannot lift a
universe-level ban — that restriction comes back as `inherited: true`.

## Errors

Everything throws `OpenCloudError`.

```ts
import { OpenCloudError } from "@minecraft2fun/roblox-opencloud";

try {
    await client.assignGroupRole({ groupId, userId, roleId });
} catch (err) {
    if (err instanceof OpenCloudError) {
        err.code;       // "FORBIDDEN" | "RATE_LIMITED" | "AUTH_REVOKED" | ...
        err.retryable;  // true for 429, 5xx, network and transient auth failures
        err.status;     // the HTTP status, when there was one
        err.robloxCode; // Roblox's own code, whatever shape it arrived in
    }
}
```

`retryable` is the only policy the library expresses. It classifies; you decide what that means
for your application.

## Anything not covered

`request()` reaches any Roblox endpoint through the same queue, credential and error handling:

```ts
// Legacy thumbnails - anonymous, synchronous, and batched, so better than the v2 generator
// for bulk work. Open Cloud v2 has exactly one thumbnail endpoint; everything else
// (group icons, asset and game thumbnails, avatar bust, batch) is only here.
const icons = await client.request<{ data: Array<{ targetId: number; imageUrl: string }> }>({
    method: "GET",
    url: "https://thumbnails.roblox.com/v1/groups/icons",
    query: { groupIds: "7", size: "150x150", format: "Png" },
    auth: "none",
});

// Roblox now proxies some legacy group endpoints under Open Cloud auth.
await client.request({
    method: "PATCH",
    url: "/legacy-groups/v1/groups/{groupId}/status",
    params: { groupId },
    body: { message: "Hello" },
});
```

For something you call often, define it properly and keep full typing:

```ts
import { defineOperation } from "@minecraft2fun/roblox-opencloud";

const setShout = defineOperation<{ groupId: string; message: string }, { body: string }>({
    name: "SetShout",
    method: "PATCH",
    path: "/legacy-groups/v1/groups/{groupId}/status",
    build: (input) => ({ params: { groupId: input.groupId }, body: { message: input.message } }),
    transform: (data) => data as { body: string },
});

await client.call(setShout, { groupId, message: "Hello" });
```

## Optional server

`@minecraft2fun/roblox-opencloud/server` exposes the client over HTTP, so several services can
share one queue, one rate-limit view and one credential set. It needs `hono`, an optional peer
dependency.

```ts
import { createServer } from "@minecraft2fun/roblox-opencloud/server";

const { app, close } = createServer({
    credentials: { groups: pool([apiKey(a), apiKey(b)]), moderation: apiKey(c) },
    defaultCredential: "groups",
    authToken: process.env.SHARED_SECRET,
});
```

Callers `POST /request` with `{ operation, input, credential }` and long-poll `GET /jobs/:id`.
Credentials are addressed **by name**, so raw keys never cross the wire. `createServer` returns
the app rather than binding a port — use `Bun.serve`, `@hono/node-server`, or whatever you run.

Jobs live in memory, so a restart loses those in flight and clients must tolerate a 404.

## Logging

Optional, and off by default. The interface is fields-first, so `pino` and `bunyan` satisfy it
with no adapter:

```ts
new OpenCloudClient({ credential, logger: pino() });
// or
new OpenCloudClient({ credential, logger: { debug: console.debug, warn: console.warn, error: console.error } });
```

Credential values, `Authorization` headers and refresh tokens are never logged — credentials are
identified by a SHA-256 fingerprint.

## Things worth knowing about Open Cloud

- **Most of this API is beta.** Every `/cloud/v2/groups/*` endpoint and every user-restriction
  endpoint is marked beta by Roblox and its response shapes have changed before —
  `GroupMembership` recently gained a `roles` array, and `role` is now only the member's *highest*
  role. Only `getUser` and the thumbnail endpoints are stable.
- **OAuth is rate-limited far harder than API keys.** `getUser` allows 1000/min per API-key owner
  but 10/min per OAuth authorization. Group endpoints are 300 vs 90.
- **`getUsersByUsername` takes no credential**, so its limit is per source IP. A `pool()` cannot
  spread its load, and there is no Open Cloud v2 equivalent to switch to.
- **Roblox refuses to assign a role at or above the acting credential's own rank**, so your key
  owner's position in the group bounds what you can do.
- **An API key created under a *group* account 403s the join-request endpoints** with no useful
  message. The key owner must be a user holding the group's `acceptRequests` permission.
- **`setUserRestriction` is limited to 2 requests per minute for the same user in a universe.**
  That budget appears in no response header, so it is discovered as a 429 rather than avoided.
- **Open Cloud says `groups`, never `communities`.** Roblox renamed Groups to Communities in the
  web UI only; the API still routes on `/cloud/v2/groups` and still names resources
  `groups/{id}/roles/{id}`. A find-and-replace 404s every group call. There is a test that fails
  the build if the word ever appears.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
