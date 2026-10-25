import { GitHubClient } from "../../src/github/client";
import type { UnivaultSettings } from "../../src/settings";
import { type IndexEntry, StateStore } from "../../src/store/db";
import { Orchestrator, type SyncState } from "../../src/sync/orchestrator";
import { gitBlobSha } from "../../src/vault/hash";
import { ObsidianVaultAdapter } from "../../src/vault/obsidian-adapter";
import { FakeGitHub } from "../fakes/github";
import { FakeVault } from "../fakes/vault";

export const TOKEN = "github_pat_secret123";
export const REPO = "octo/vault";
export const TRAILER = "Univault-Device: octo/Mac";

export async function createHarness() {
	const github = new FakeGitHub();
	github.addToken(TOKEN, "octo");
	github.createRepo(REPO);
	return createDevice(github, "Mac");
}

// One device: its own vault and state store, talking to a shared fake GitHub.
export async function createDevice(github: FakeGitHub, deviceName: string) {
	const vault = new FakeVault();
	const store = await StateStore.open(crypto.randomUUID());
	const indexVault = async (paths: string[]): Promise<IndexEntry[]> => {
		const entries: IndexEntry[] = [];
		for (const path of paths) {
			const { stat } = vault.getFiles().find((f) => f.path === path)!;
			const blobSha = await gitBlobSha(vault.bytes(path)!);
			entries.push({ path, mtime: stat.mtime, size: stat.size, blobSha, mode: "100644" });
		}
		return entries;
	};
	const h = {
		github,
		vault,
		store,
		settings: { repository: REPO, branch: "main", deviceName } as UnivaultSettings,
		signedIn: true,
		states: [] as SyncState[],
		// The device clock, for sibling names and snapshot times; null is the real clock.
		now: null as (() => Date) | null,
		mergeCapBytes: 1024,
		orchestrator: null as unknown as Orchestrator,
		// Vault and branch agree, and the anchor holds the current ref ETag.
		async inSync(files: Record<string, string | Uint8Array>): Promise<string> {
			const commitSha = github.commitFiles(REPO, "main", files);
			for (const [path, content] of Object.entries(files)) vault.setFile(path, content);
			const res = await github.fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/main`, {
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			const treeSha = github.commit(REPO, commitSha)!.tree;
			const anchor = { repository: REPO, branch: "main", commitSha, treeSha, refEtag: res.headers.get("etag") };
			await store.advance(anchor, await indexVault(Object.keys(files)));
			github.requests.length = 0;
			return commitSha;
		},
		// A second device holding this one's vault and sync state; this one must be in sync.
		async fork(name: string) {
			const other = await createDevice(github, name);
			for (const [path, file] of vault.files) other.vault.setFile(path, file.bytes.slice());
			const anchor = await store.getAnchor();
			if (anchor) await other.store.advance(anchor, await other.indexVault([...vault.files.keys()]));
			return other;
		},
		indexVault,
	};
	const client = new GitHubClient({ fetch: github.fetch, host: "https://api.github.com", token: TOKEN, sleep: async () => {} });
	h.orchestrator = new Orchestrator({
		session: () => (h.signedIn ? { client, login: "octo" } : null),
		settings: () => h.settings,
		store,
		vault: new ObsidianVaultAdapter(vault),
		uploadCapBytes: 1024,
		configDir: ".obsidian",
		pluginDir: ".obsidian/plugins/univault",
		now: () => h.now?.() ?? new Date(),
		get mergeCapBytes() {
			return h.mergeCapBytes;
		},
	});
	h.orchestrator.onChange(() => h.states.push(h.orchestrator.state));
	return h;
}

export type Harness = Awaited<ReturnType<typeof createDevice>>;
