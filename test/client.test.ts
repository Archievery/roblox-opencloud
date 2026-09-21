import { describe, it, expect } from "vitest";
import { OpenCloudClient, apiKey, defineOperation } from "../src/index.js";
import { fastTimings, response, stubHttp } from "./helpers.js";
import { GROUP_ID, USER_ID, rawGroup, rawGroupRoles, rawGroupRolesPaged, rawUser } from "./fixtures.js";

function makeClient(http: ReturnType<typeof stubHttp>, credential = apiKey("k", { id: "cred" })) {
    return new OpenCloudClient({ http: http.adapter, credential, timings: fastTimings });
}

describe("OpenCloudClient", () => {
    it("routes a method to the right URL and returns the mapped DTO", async () => {
        const http = stubHttp();
        http.push(response(rawUser));

        const user = await makeClient(http).getUser({ userId: USER_ID });

        expect(http.calls[0]?.url).toBe(`https://apis.roblox.com/cloud/v2/users/${USER_ID}`);
        expect(user.username).toBe("Builderman");
    });

    it("works with no credential at all for an anonymous endpoint", async () => {
        const http = stubHttp();
        http.push(response({ data: [] }));
        const client = new OpenCloudClient({ http: http.adapter });

        await expect(client.getUsersByUsername({ usernames: ["Roblox"] })).resolves.toEqual([]);
    });

    it("explains itself when a credential is required but absent", async () => {
        const http = stubHttp();
        const client = new OpenCloudClient({ http: http.adapter });

        await expect(client.getUser({ userId: USER_ID })).rejects.toMatchObject({ code: "NO_CREDENTIAL" });
        await expect(client.getUser({ userId: USER_ID })).rejects.toThrow(/apiKey\(/);
    });

    it("sends a default user agent that names the package", async () => {
        const http = stubHttp();
        http.push(response(rawGroup));
        await makeClient(http).getGroup({ groupId: GROUP_ID });
        expect(http.calls[0]?.headers["User-Agent"]).toMatch(/roblox-opencloud/);
    });
});

describe("OpenCloudClient.paginate", () => {
    it("follows nextPageToken to the end", async () => {
        const http = stubHttp();
        http.push(response(rawGroupRolesPaged), response(rawGroupRoles));
        const client = makeClient(http);

        const roles = [];
        for await (const role of client.paginate(
            (await import("../src/operations/index.js")).listGroupRoles,
            { groupId: GROUP_ID },
        )) {
            roles.push(role);
        }

        // Two pages of two roles each, and the page token is threaded through for the caller.
        expect(roles).toHaveLength(4);
        expect(http.calls).toHaveLength(2);
        expect(http.calls[1]?.url).toContain("pageToken=page-token-abc");
    });

    it("stops after one page when there is no token", async () => {
        const http = stubHttp();
        http.push(response(rawGroupRoles));
        const client = makeClient(http);
        const ops = await import("../src/operations/index.js");

        const roles = [];
        for await (const role of client.paginate(ops.listGroupRoles, { groupId: GROUP_ID })) roles.push(role);

        expect(roles).toHaveLength(2);
        expect(http.calls).toHaveLength(1);
    });
});

describe("OpenCloudClient.call with a consumer-defined operation", () => {
    it("runs an operation the package does not ship", async () => {
        const http = stubHttp();
        http.push(response({ shout: "hello" }));
        const readShout = defineOperation<{ groupId: string }, string>({
            name: "ReadShout",
            method: "GET",
            path: "/legacy-groups/v1/groups/{groupId}/status",
            build: (input) => ({ params: { groupId: input.groupId } }),
            transform: (data) => (data as { shout: string }).shout,
        });

        await expect(makeClient(http).call(readShout, { groupId: GROUP_ID })).resolves.toBe("hello");
        expect(http.calls[0]?.url).toBe(`https://apis.roblox.com/legacy-groups/v1/groups/${GROUP_ID}/status`);
    });
});

describe("OpenCloudClient.request", () => {
    it("reaches a legacy absolute URL anonymously", async () => {
        const http = stubHttp();
        http.push(response({ data: [{ targetId: 1, state: "Completed", imageUrl: "https://x/y.png" }] }));

        const result = await makeClient(http).request<{ data: unknown[] }>({
            method: "GET",
            url: "https://thumbnails.roblox.com/v1/users/avatar-headshot",
            query: { userIds: "1", size: "150x150", format: "Png" },
            auth: "none",
        });

        expect(http.calls[0]?.url).toBe(
            "https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=1&size=150x150&format=Png",
        );
        expect(http.calls[0]?.headers["x-api-key"]).toBeUndefined();
        expect(result.data).toHaveLength(1);
    });

    it("supports PATCH and a request body", async () => {
        const http = stubHttp();
        http.push(response({ newDescription: "hi" }));

        await makeClient(http).request({
            method: "PATCH",
            url: "/legacy-groups/v1/groups/{groupId}/description",
            params: { groupId: GROUP_ID },
            body: { description: "hi" },
        });

        expect(http.calls[0]?.method).toBe("PATCH");
        expect(http.calls[0]?.body).toBe('{"description":"hi"}');
    });

    it("unwraps a long-running operation when asked to", async () => {
        const http = stubHttp();
        http.push(response({ path: "users/1/operations/x", done: true, response: { imageUri: "https://x/y.png" } }));

        const result = await makeClient(http).request<{ imageUri: string }>({
            method: "GET",
            url: "/cloud/v2/users/{userId}:generateThumbnail",
            params: { userId: "1" },
            longPoll: true,
        });

        expect(result.imageUri).toBe("https://x/y.png");
    });

    it("keeps a custom verb intact through the escape hatch", async () => {
        const http = stubHttp();
        http.push(response({}));
        await makeClient(http).request({
            method: "GET",
            url: "/cloud/v2/universes/{universeId}/user-restrictions:listLogs",
            params: { universeId: "5" },
        });
        expect(http.calls[0]?.url).toBe("https://apis.roblox.com/cloud/v2/universes/5/user-restrictions:listLogs");
    });
});
