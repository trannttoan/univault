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
	const vault = new FakeVault();
	const store = await StateStore.open(crypto.randomUUID());
	const h = {
		github,
		vault,
		store,
		settings: { repository: REPO, branch: "main", deviceName: "Mac" } as UnivaultSettings,
		signedIn: true,
		states: [] as SyncState[],
		orchestrator: null as unknown as Orchestrator,
		// Vault and branch agree, and the anchor holds the current ref ETag.
		async inSync(files: Record<string, string | Uint8Array>): Promise<string> {
			const commitSha = github.commitFiles(REPO, "main", files);
			const entries: IndexEntry[] = [];
			for (const [path, content] of Object.entries(files)) {
				vault.setFile(path, content);
				const { stat } = vault.getFiles().find((f) => f.path === path)!;
				const blobSha = await gitBlobSha(vault.bytes(path)!);
				entries.push({ path, mtime: stat.mtime, size: stat.size, blobSha, mode: "100644" });
			}
			const res = await github.fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/main`, {
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			const treeSha = github.commit(REPO, commitSha)!.tree;
			await store.advance({ repository: REPO, branch: "main", commitSha, treeSha, refEtag: res.headers.get("etag") }, entries);
			github.requests.length = 0;
			return commitSha;
		},
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
	});
	h.orchestrator.onChange(() => h.states.push(h.orchestrator.state));
	return h;
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
