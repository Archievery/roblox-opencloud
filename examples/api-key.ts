// Run with: npx tsx examples/api-key.ts
// In your own project the import is "@minecraft2fun/roblox-opencloud"; inside this repo it
// points at the source so the examples are typechecked alongside it.
import { OpenCloudClient, OpenCloudError, apiKey } from "../src/index.js";

const key = process.env.ROBLOX_API_KEY;
if (!key) throw new Error("Set ROBLOX_API_KEY first.");

const client = new OpenCloudClient({
    credential: apiKey(key),
    // Uncomment to see what the queue is doing.
    // logger: { debug: console.debug, warn: console.warn, error: console.error },
});

const user = await client.getUser({ userId: "1" });
console.log(`${user.username} (${user.displayName}) joined ${user.createdAt}`);

const groupId = process.env.ROBLOX_GROUP_ID;
if (groupId) {
    const group = await client.getGroup({ groupId });
    console.log(`${group.name}: ${group.memberCount} members, owner ${group.ownerRobloxId ?? "(abandoned)"}`);

    // Roblox caps roles at 20 per page, so paginate rather than reading one page and hoping.
    const { listGroupRoles } = await import("../src/operations/index.js");
    for await (const role of client.paginate(listGroupRoles, { groupId })) {
        console.log(`  rank ${role.rank}: ${role.displayName} (${role.memberCount})`);
    }
}

try {
    await client.getUser({ userId: "0" });
} catch (err) {
    if (err instanceof OpenCloudError) console.log(`${err.code} (retryable: ${err.retryable}): ${err.message}`);
    else throw err;
}
