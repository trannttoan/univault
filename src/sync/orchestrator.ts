import { UnivaultError } from "../errors";
import type { GitHubClient } from "../github/client";
import type { UnivaultSettings } from "../settings";
import type { IndexEntry, StateStore, SyncAnchor } from "../store/db";
import { download } from "../transfer/download";
import { bootstrapBranch, uploadBlob } from "../transfer/upload";
import type { VaultAdapter } from "../vault/adapter";
import { canonicalizeRepoPath, normalizeVaultPath } from "../vault/paths";
import { classifyAll } from "./classify";
import { commitMessage, createSyncCommit } from "./commit";
import { type LocalChange, localDelta } from "./local-delta";
import { type HeadCheck, type RemoteChange, checkHead, remoteDelta } from "./remote-delta";

export type SyncState = "idle" | "syncing" | "error";

export type SyncOutcome =
	| { kind: "synced"; uploaded: number; downloaded: number }
	| { kind: "remote-empty"; branch: string }
	| { kind: "needs-setup" }
	| { kind: "missing-branch"; branch: string; error: UnivaultError }
	| { kind: "failed"; error: UnivaultError };

export interface OrchestratorDeps {
	session(): { client: GitHubClient; login: string } | null;
	settings(): UnivaultSettings;
	store: StateStore;
	vault: VaultAdapter;
	uploadCapBytes: number;
	configDir: string;
	pluginDir: string;
}

interface Context {
	client: GitHubClient;
	login: string;
	settings: UnivaultSettings;
}

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const MAX_REF_RETRIES = 3;
const FILE_MODE = "100644";

export class Orchestrator {
	state: SyncState = "idle";
	lastOutcome: SyncOutcome | null = null;
	lastSyncAt: Date | null = null;
	private current: Promise<SyncOutcome> | null = null;
	private again = false;
	private readonly listeners: (() => void)[] = [];

	constructor(private readonly deps: OrchestratorDeps) {}

	onChange(listener: () => void): void {
		this.listeners.push(listener);
	}

	// Single flight: a call during a run schedules one follow-up run and shares its result.
	sync(_reason: "manual"): Promise<SyncOutcome> {
		if (this.current) {
			this.again = true;
			return this.current;
		}
		this.current = this.loop().finally(() => {
			this.current = null;
		});
		return this.current;
	}

	private async loop(): Promise<SyncOutcome> {
		let outcome: SyncOutcome;
		do {
			this.again = false;
			this.setState("syncing");
			outcome = await this.runOnce();
			this.lastOutcome = outcome;
			const ok = outcome.kind === "synced" || outcome.kind === "remote-empty";
			if (ok) this.lastSyncAt = new Date();
			this.setState(ok ? "idle" : "error");
		} while (this.again);
		return outcome;
	}

	private async runOnce(): Promise<SyncOutcome> {
		try {
			const session = this.deps.session();
			const settings = this.deps.settings();
			if (!session || !REPOSITORY.test(settings.repository) || !settings.branch) return { kind: "needs-setup" };
			await this.deps.vault.removeTempFiles();

			// A rejected ref update means another device pushed first: start over from the head check.
			for (let attempt = 0; ; attempt++) {
				const outcome = await this.cycle({ ...session, settings });
				if (outcome !== "rejected") return outcome;
				if (attempt === MAX_REF_RETRIES) throw new UnivaultError("conflict-retry");
			}
		} catch (error) {
			return {
				kind: "failed",
				error: error instanceof UnivaultError ? error : new UnivaultError("unknown", { cause: error }),
			};
		}
	}

	private async cycle(context: Context, bootstrapped = false): Promise<SyncOutcome | "rejected"> {
		const { client, login, settings } = context;
		const { store, vault } = this.deps;
		const { repository, branch } = settings;

		let anchor = await store.getAnchor();
		if (anchor && (anchor.repository !== repository || anchor.branch !== branch)) {
			await store.discardAnchor();
			anchor = null;
		}

		// Without an anchor the head always reads as changed, and the remote delta is the full tree.
		const index = await store.getIndex();
		let check: HeadCheck;
		try {
			check = await checkHead(client, repository, branch, anchor);
		} catch (error) {
			const missing = error instanceof UnivaultError && error.code === "not-found";
			if (missing && !anchor && !bootstrapped) return this.bootstrap(context, index);
			throw error;
		}
		let head = anchor ? { commitSha: anchor.commitSha, treeSha: anchor.treeSha } : null;
		let remote = new Map<string, RemoteChange>();
		if (check.kind === "changed") {
			head = { commitSha: check.sha, treeSha: (await client.getCommit(repository, check.sha)).treeSha };
			const canonical = (path: string) => canonicalizeRepoPath(path, this.deps.configDir, this.deps.pluginDir);
			remote = await remoteDelta(client, repository, anchor, head, index, canonical);
		}
		if (!head) throw new UnivaultError("unknown", { cause: new Error("No head without an anchor") });

		const local = await localDelta(vault, index);
		const outcomes = classifyAll(local, remote);
		const conflicts = [...outcomes].filter(([, o]) => o === "conflict").map(([path]) => path);
		if (conflicts.length) throw new UnivaultError("conflict-retry", { paths: conflicts.sort() });

		const indexed = sameOnBothSides(outcomes, local, remote);
		const downloads = [...outcomes].filter(([, o]) => o === "download").map(([path]) => path);
		for (const path of downloads) {
			await download(client, repository, vault, path, (remote.get(path) as { sha: string }).sha);
		}
		indexed.push(...(await this.downloadedEntries(downloads, remote)));

		const uploads = [...outcomes].filter(([, o]) => o === "upload").map(([path]) => path);
		if (uploads.length === 0) {
			const next: SyncAnchor = { repository, branch, ...head, refEtag: check.etag };
			if (check.kind === "changed" || check.etag !== anchor?.refEtag || indexed.length) await store.advance(next, indexed);
			return { kind: "synced", uploaded: 0, downloaded: downloads.length };
		}

		const entries: IndexEntry[] = [];
		for (const path of uploads) {
			const change = local.get(path) as Extract<LocalChange, { vaultPath: string }>;
			const blob = await uploadBlob(client, repository, vault, { path, ...change }, this.deps.uploadCapBytes);
			entries.push({ path, mtime: change.mtime, size: blob.size, blobSha: blob.sha, mode: FILE_MODE });
		}
		const tree = entries.map((e) => ({ path: e.path, mode: FILE_MODE, type: "blob", sha: e.blobSha }) as const);
		const commit = await createSyncCommit(client, repository, head, tree, commitMessage(settings.deviceName, login));

		try {
			await client.updateRef(repository, branch, commit.commitSha);
		} catch (error) {
			if (error instanceof UnivaultError && error.code === "conflict-retry") return "rejected";
			throw error;
		}
		await store.advance({ repository, branch, ...commit, refEtag: null }, [...entries, ...indexed]);
		return { kind: "synced", uploaded: entries.length, downloaded: downloads.length };
	}

	// No branch to read: an empty repository, or a branch missing from a non-empty one.
	private async bootstrap(context: Context, index: Map<string, IndexEntry>): Promise<SyncOutcome | "rejected"> {
		const { client, login, settings } = context;
		const local = await localDelta(this.deps.vault, index);
		const files = [...local].filter(([, c]) => c.kind !== "deleted").sort(([a], [b]) => (a < b ? -1 : 1));
		if (files.length === 0) return { kind: "remote-empty", branch: settings.branch };

		const [path, change] = files[0] as [string, Extract<LocalChange, { vaultPath: string }>];
		const message = commitMessage(settings.deviceName, login);
		try {
			const file = { path, ...change };
			const { repository, branch } = settings;
			await bootstrapBranch(client, repository, branch, this.deps.vault, file, this.deps.uploadCapBytes, message);
		} catch (error) {
			// 404 here means a non-empty repository without this branch; phase 0 never creates one.
			if (error instanceof UnivaultError && error.code === "not-found") {
				return { kind: "missing-branch", branch: settings.branch, error };
			}
			throw error;
		}
		const rest = await this.cycle(context, true);
		return rest !== "rejected" && rest.kind === "synced" ? { ...rest, uploaded: rest.uploaded + 1 } : rest;
	}

	private async downloadedEntries(paths: string[], remote: Map<string, RemoteChange>): Promise<IndexEntry[]> {
		if (paths.length === 0) return [];
		const stats = new Map((await this.deps.vault.list()).map((file) => [normalizeVaultPath(file.path), file]));
		return paths.map((path) => {
			const stat = stats.get(path);
			if (!stat) throw new UnivaultError("unknown", { cause: new Error("Downloaded file is missing"), paths: [path] });
			const sha = (remote.get(path) as { sha: string }).sha;
			return { path, mtime: stat.mtime, size: stat.size, blobSha: sha, mode: FILE_MODE };
		});
	}

	private setState(state: SyncState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}

// Paths both sides changed to the same content: nothing to transfer, but the index learns them.
function sameOnBothSides(
	outcomes: Map<string, string>,
	local: Map<string, LocalChange>,
	remote: Map<string, RemoteChange>,
): IndexEntry[] {
	const entries: IndexEntry[] = [];
	for (const [path, outcome] of outcomes) {
		const ours = local.get(path);
		if (outcome === "noop" && ours && ours.kind !== "deleted" && remote.has(path)) {
			entries.push({ path, mtime: ours.mtime, size: ours.size, blobSha: ours.blobSha, mode: FILE_MODE });
		}
	}
	return entries;
}
