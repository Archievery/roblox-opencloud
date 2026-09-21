// Run with: npx tsx examples/oauth-rotation.ts
//
// Roblox refresh tokens are single-use and rotate on EVERY refresh. If you do not persist the
// rotated token, your next refresh fails with invalid_grant and the user has to re-authorize.
// That is the whole reason onTokensRefreshed exists.
import { readFileSync, writeFileSync } from "node:fs";
import { OpenCloudClient, OpenCloudError, oauth } from "../src/index.js";

const STORE = new URL("./.tokens.json", import.meta.url).pathname;

function load(): { refreshToken: string } {
    try {
        return JSON.parse(readFileSync(STORE, "utf8")) as { refreshToken: string };
    } catch {
        const seed = process.env.ROBLOX_REFRESH_TOKEN;
        if (!seed) throw new Error("Set ROBLOX_REFRESH_TOKEN once to seed the store.");
        return { refreshToken: seed };
    }
}

const client = new OpenCloudClient({
    credential: oauth({
        clientId: process.env.ROBLOX_CLIENT_ID ?? "",
        clientSecret: process.env.ROBLOX_CLIENT_SECRET ?? "",
        refreshToken: load().refreshToken,
        // Awaited before the request that triggered the refresh is sent. Write it somewhere
        // durable: a crash between the exchange and the write loses the credential.
        onTokensRefreshed: (tokens) => {
            writeFileSync(STORE, JSON.stringify({ refreshToken: tokens.refreshToken }, null, 2));
            console.log(`rotated; next expiry ${tokens.expiresAt.toISOString()}, scopes: ${tokens.scope}`);
        },
    }),
});

try {
    // Twenty concurrent calls perform exactly one token exchange: the credential is
    // single-flighted, because two parallel refreshes would invalidate each other.
    const users = await Promise.all(["1", "2", "3"].map((userId) => client.getUser({ userId })));
    for (const user of users) console.log(user.username);
} catch (err) {
    if (err instanceof OpenCloudError && err.code === "AUTH_REVOKED") {
        console.error("The refresh token is dead - the user must authorize again.");
    } else {
        throw err;
    }
}
