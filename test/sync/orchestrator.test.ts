import { beforeEach, describe, expect, it } from "vitest";
import { GitHubClient } from "../../src/github/client";
import type { UnivaultSettings } from "../../src/settings";
import { type IndexEntry, StateStore } from "../../src/store/db";
import { Orchestrator, type SyncState } from "../../src/sync/orchestrator";
import { gitBlobSha } from "../../src/vault/hash";
import { ObsidianVaultAdapter } from "../../src/vault/obsidian-adapter";
import { FakeGitHub } from "../fakes/github";
import { FakeVault } from "../fakes/vault";

const TOKEN = "github_pat_secret123";
const REPO = "octo/vault";

describe("Orchestrator", () => {
	let github: FakeGitHub;
	let vault: FakeVault;
	let store: StateStore;
	let settings: UnivaultSettings;
	let signedIn: boolean;
	let orchestrator: Orchestrator;
	let states: SyncState[];

	beforeEach(async () => {
		github = new FakeGitHub();
		github.addToken(TOKEN, "octo");
		github.createRepo(REPO);
		vault = new FakeVault();
		store = await StateStore.open(crypto.randomUUID());
		settings = { repository: REPO, branch: "main", deviceName: "Mac" };
		signedIn = true;
		const client = new GitHubClient({ fetch: github.fetch, host: "https://api.github.com", token: TOKEN, sleep: async () => {} });
		orchestrator = new Orchestrator({
			session: () => (signedIn ? { client, login: "octo" } : null),
			settings: () => settings,
			store,
			vault: new ObsidianVaultAdapter(vault),
		});
		states = [];
		orchestrator.onChange(() => states.push(orchestrator.state));
	});

	// Vault and branch agree, and the anchor holds the current ref ETag.
	async function inSync(files: Record<string, string>): Promise<void> {
		const commitSha = github.commitFiles(REPO, "main", files);
		const entries: IndexEntry[] = [];
		for (const [path, content] of Object.entries(files)) {
			vault.setFile(path, content);
			const { stat } = vault.getFiles().find((f) => f.path === path)!;
			entries.push({ path, mtime: stat.mtime, size: stat.size, blobSha: await gitBlobSha(vault.bytes(path)!), mode: "100644" });
		}
		const ref = await fetchRef();
		await store.advance(
			{ repository: REPO, branch: "main", commitSha, treeSha: github.commit(REPO, commitSha)!.tree, refEtag: ref },
			entries,
		);
		github.requests.length = 0;
	}

	async function fetchRef(): Promise<string> {
		const res = await github.fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/main`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		return res.headers.get("etag")!;
	}

	it("makes one free 304 request and no commit when nothing changed", async () => {
		await inSync({ "a.md": "a", "notes/b.md": "b" });
		const head = github.head(REPO, "main");
		const quota = github.rateLimitRemaining;

		expect(await orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });

		expect(github.requests).toEqual([{ method: "GET", path: `/repos/${REPO}/git/ref/heads/main`, status: 304 }]);
		expect(github.rateLimitRemaining).toBe(quota);
		expect(github.head(REPO, "main")).toBe(head);
		expect(states).toEqual(["syncing", "idle"]);
		expect(orchestrator.lastSyncAt).not.toBeNull();
	});

	it("stores a fresh ref ETag when the head matches the anchor without one", async () => {
		await inSync({ "a.md": "a" });
		const anchor = (await store.getAnchor())!;
		await store.advance({ ...anchor, refEtag: null }, []);

		await orchestrator.sync("manual");
		expect((await store.getAnchor())?.refEtag).toMatch(/^W\//);

		github.requests.length = 0;
		await orchestrator.sync("manual");
		expect(github.requests.map((r) => r.status)).toEqual([304]);
	});

	it("coalesces calls during a run into one follow-up", async () => {
		await inSync({ "a.md": "a" });
		const first = orchestrator.sync("manual");
		const second = orchestrator.sync("manual");
		const third = orchestrator.sync("manual");

		expect(await first).toEqual(await second);
		expect(await third).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });
		expect(github.requests).toHaveLength(2);
		expect(states).toEqual(["syncing", "idle", "syncing", "idle"]);
	});

	it("moves to error on a UnivaultError and back to idle on the next success", async () => {
		await inSync({ "a.md": "a" });
		github.inject("GET", /git\/ref/, { status: 401 });

		const failed = await orchestrator.sync("manual");
		expect(failed.kind === "failed" && failed.error.code).toBe("auth-expired");
		expect(orchestrator.state).toBe("error");

		expect((await orchestrator.sync("manual")).kind).toBe("synced");
		expect(orchestrator.state).toBe("idle");
	});

	it("reports needs-setup without a session or repository and makes no request", async () => {
		signedIn = false;
		expect(await orchestrator.sync("manual")).toEqual({ kind: "needs-setup" });
		signedIn = true;
		settings = { ...settings, repository: "" };
		expect(await orchestrator.sync("manual")).toEqual({ kind: "needs-setup" });
		expect(orchestrator.state).toBe("error");
		expect(github.requests).toHaveLength(0);
	});

	it("removes temp files left by an interrupted download", async () => {
		await inSync({ "a.md": "a" });
		vault.setFile("b.md.univault-partial", "par");
		await orchestrator.sync("manual");
		expect(vault.files.has("b.md.univault-partial")).toBe(false);
	});

	it("ignores a local deletion in phase 0", async () => {
		await inSync({ "a.md": "a", "b.md": "b" });
		vault.files.delete("b.md");
		expect((await orchestrator.sync("manual")).kind).toBe("synced");
		expect(github.requests).toHaveLength(1);
	});
});
