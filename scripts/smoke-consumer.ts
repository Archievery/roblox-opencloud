import { OpenCloudClient, OpenCloudError, apiKey, oauth, pool, custom, defineOperation, DEFAULT_TIMINGS } from "../dist/index.js";
import type { Credential, Logger, Group, GroupRole, Page, UserRestriction, Timings } from "../dist/index.js";
import { createServer } from "../dist/server/index.js";

const credential: Credential = pool([apiKey("a"), custom("c", () => "t")]);
const logger: Logger = { debug: () => {}, warn: () => {}, error: () => {} };
const timings: Partial<Timings> = { maxRetries: 1 };

const client = new OpenCloudClient({ credential, logger, timings });

async function main(): Promise<void> {
    const group: Group = await client.getGroup({ groupId: "7" });
    const roles: Page<GroupRole> = await client.listGroupRoles({ groupId: group.groupId });
    const restriction: UserRestriction = await client.getUserRestriction({ universeId: "1", userId: "2" });
    console.log(group.ownerRobloxId, roles.items.length, restriction.gameJoinRestriction.durationSeconds);

    // The generic escape hatch must infer the caller's type parameter.
    const raw = await client.request<{ ok: boolean }>({ method: "GET", url: "/x", auth: "none" });
    console.log(raw.ok);

    // defineOperation must still infer input and output through the published declarations.
    const op = defineOperation<{ id: string }, { n: number }>({
        name: "X", method: "GET", path: "/y/{id}",
        build: (i) => ({ params: { id: i.id } }),
        transform: (d) => d as { n: number },
    });
    const out = await client.call(op, { id: "1" });
    console.log(out.n);

    for await (const role of client.paginate(op as never, {} as never)) console.log(role);

    const server = createServer({ credentials: { a: apiKey("k") } });
    server.close();

    console.log(DEFAULT_TIMINGS.maxRetries, oauth, OpenCloudError.name);
}
void main;
