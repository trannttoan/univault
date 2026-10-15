import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ErrorCode, UnivaultError } from "../../src/errors";
import { GitHubClient } from "../../src/github/client";
import { FakeGitHub } from "../fakes/github";

const TOKEN = "github_pat_secret123";
const REPO = "owner/vault";
const HOST = "https://api.github.com";

function errorText(error: unknown): string {
	const parts: string[] = [];
	for (let e = error; e; e = (e as { cause?: unknown }).cause) {
		parts.push(String(e), (e as Error).message ?? "", (e as Error).stack ?? "");
	}
	return parts.join("\n");
}

async function caught(promise: Promise<unknown>): Promise<UnivaultError> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(UnivaultError);
	return error as UnivaultError;
}

function stubFetch(...responses: (Response | Error)[]) {
	return vi.fn(async () => {
		const next = responses.shift();
		if (!next) throw new Error("no more stub responses");
		if (next instanceof Error) throw next;
		return next;
	});
}

const reply = (status: number, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify({ message: `rejected token ${TOKEN}` }), { status, headers });

describe("GitHubClient", () => {
	let github: FakeGitHub;
	let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
	let client: GitHubClient;

	beforeEach(() => {
		github = new FakeGitHub();
		github.addToken(TOKEN, "octo");
		github.createRepo(REPO);
		sleep = vi.fn(async () => {});
		client = new GitHubClient({ fetch: github.fetch, host: HOST, token: TOKEN, sleep });
	});

	it("rejects a non-HTTPS host before any request", () => {
		const fetch = vi.fn();
		expect(() => new GitHubClient({ fetch, host: "http://api.github.com", token: TOKEN })).toThrow(UnivaultError);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("sends the token, accept and api version headers", async () => {
		const fetch = stubFetch(new Response(JSON.stringify({ login: "octo" })));
		await new GitHubClient({ fetch, host: HOST, token: TOKEN }).getUser();
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.github.com/user");
		expect(init.headers).toMatchObject({
			Authorization: `Bearer ${TOKEN}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		});
	});

	it("bypasses the http cache on reads and writes", async () => {
		github.commitFiles(REPO, "main", { "a.md": "a" });
		await client.getRef(REPO, "main");
		await client.createBlob(REPO, new Uint8Array([1]));
		expect(github.cacheModes).toEqual(["no-store", "no-store"]);
	});

	it("returns the login for the token", async () => {
		expect(await client.getUser()).toEqual({ login: "octo" });
	});

	describe("status mapping", () => {
		const cases: [string, Response | Error, ErrorCode][] = [
			["401", reply(401), "auth-expired"],
			["403 with remaining 0", reply(403, { "x-ratelimit-remaining": "0" }), "rate-limited"],
			["403 with a long retry-after", reply(403, { "retry-after": "3600" }), "rate-limited"],
			["429", reply(429), "rate-limited"],
			["403 without rate-limit headers", reply(403), "forbidden"],
			["404", reply(404), "not-found"],
			["409", reply(409), "unknown"],
			["422 outside a ref update", reply(422), "unknown"],
			["network failure", new TypeError(`fetch failed for ${TOKEN}`), "offline"],
		];

		it.each(cases)("maps %s on a write", async (_name, response, code) => {
			const fetch = stubFetch(response);
			const writer = new GitHubClient({ fetch, host: HOST, token: TOKEN, sleep });
			const error = await caught(writer.createBlob(REPO, new Uint8Array([1])));
			expect(error.code).toBe(code);
			expect(errorText(error)).not.toContain(TOKEN);
			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it("maps a non-fast-forward ref update to conflict-retry", async () => {
			const first = github.commitFiles(REPO, "main", { "a.md": "a" });
			github.commitFiles(REPO, "main", { "a.md": "b" });
			const error = await caught(client.updateRef(REPO, "main", first));
			expect(error.code).toBe("conflict-retry");
		});
	});

	describe("read retries", () => {
		it("retries a 5xx read three times with backoff, then fails", async () => {
			const fetch = stubFetch(reply(502), reply(502), reply(503), reply(500));
			const reader = new GitHubClient({ fetch, host: HOST, token: TOKEN, sleep });
			expect((await caught(reader.getUser())).code).toBe("unknown");
			expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
		});

		it("honors Retry-After on a rate-limited read", async () => {
			const fetch = stubFetch(reply(403, { "retry-after": "7" }), new Response(JSON.stringify({ login: "octo" })));
			const reader = new GitHubClient({ fetch, host: HOST, token: TOKEN, sleep });
			expect(await reader.getUser()).toEqual({ login: "octo" });
			expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([7000]);
		});

		it("retries a read through network failures, then reports offline", async () => {
			const error = new TypeError("fetch failed");
			const reader = new GitHubClient({ fetch: stubFetch(error, error, error, error), host: HOST, token: TOKEN, sleep });
			expect((await caught(reader.getUser())).code).toBe("offline");
			expect(sleep).toHaveBeenCalledTimes(3);
		});

		it("does not retry writes", async () => {
			const fetch = stubFetch(reply(502));
			const writer = new GitHubClient({ fetch, host: HOST, token: TOKEN, sleep });
			expect((await caught(writer.createBlob(REPO, new Uint8Array([1])))).code).toBe("unknown");
			expect(sleep).not.toHaveBeenCalled();
		});
	});

	it("round-trips the ref ETag into a free 304", async () => {
		const sha = github.commitFiles(REPO, "main", { "a.md": "a" });
		const first = await client.getRef(REPO, "main");
		expect(first).toMatchObject({ kind: "found", sha });
		const etag = first.kind === "found" ? first.etag : null;
		expect(etag).toMatch(/^W\//);

		const quota = github.rateLimitRemaining;
		expect(await client.getRef(REPO, "main", etag)).toEqual({ kind: "not-modified" });
		expect(github.requests.at(-1)?.status).toBe(304);
		expect(github.rateLimitRemaining).toBe(quota);

		const moved = github.commitFiles(REPO, "main", { "a.md": "b" });
		expect(await client.getRef(REPO, "main", etag)).toMatchObject({ kind: "found", sha: moved });
	});

	it("maps a missing branch to not-found", async () => {
		github.commitFiles(REPO, "main", { "a.md": "a" });
		expect((await caught(client.getRef(REPO, "other"))).code).toBe("not-found");
	});

	it("reports an empty repository from the ref read, and 409 on other reads as not-found", async () => {
		expect(await client.getRef(REPO, "main")).toEqual({ kind: "empty" });
		expect((await caught(client.getTree(REPO, "a".repeat(40)))).code).toBe("not-found");
		expect((await caught(client.getBlobStream(REPO, "a".repeat(40)))).code).toBe("not-found");
		expect(github.requests.map((r) => r.status)).toEqual([409, 409, 409]);
		expect((await caught(client.createBlob(REPO, new Uint8Array([1])))).code).toBe("unknown");
	});

	it("maps 404 from the contents api on a missing branch to not-found", async () => {
		github.commitFiles(REPO, "main", { "a.md": "a" });
		const put = client.putContents(REPO, "x.md", { branch: "nope", message: "m", bytes: new Uint8Array([1]) });
		expect((await caught(put)).code).toBe("not-found");
	});

	it("writes a commit through blobs, trees, commits and a fast-forward ref update", async () => {
		const parent = github.commitFiles(REPO, "main", { "keep.md": "keep" });
		const bytes = new Uint8Array([...Array(256).keys(), 13, 10]);

		const blob = await client.createBlob(REPO, bytes);
		const head = await client.getCommit(REPO, parent);
		const tree = await client.createTree(REPO, head.treeSha, [{ path: "bin/all.dat", mode: "100644", type: "blob", sha: blob }]);
		const commit = await client.createCommit(REPO, { message: "m", tree, parents: [parent] });
		await client.updateRef(REPO, "main", commit);

		expect(github.head(REPO, "main")).toBe(commit);
		expect((await client.getTree(REPO, tree)).entries.filter((e) => e.type === "blob").map((e) => e.path)).toEqual([
			"bin/all.dat",
			"keep.md",
		]);
		expect(await client.getCompare(REPO, parent, commit)).toEqual({
			status: "ahead",
			files: [{ filename: "bin/all.dat", status: "added", sha: blob }],
		});

		const stream = await client.getBlobStream(REPO, blob);
		const received = new Uint8Array(await new Response(stream).arrayBuffer());
		expect(received).toEqual(bytes);
	});

	it("creates the first commit of an empty repository through the contents api", async () => {
		const result = await client.putContents(REPO, "notes/first.md", {
			branch: "main",
			message: "Sync from Mac",
			bytes: new TextEncoder().encode("hi"),
		});
		expect(github.head(REPO, "main")).toBe(result.commitSha);
		expect(new TextDecoder().decode(github.file(REPO, "main", "notes/first.md"))).toBe("hi");
	});
});
