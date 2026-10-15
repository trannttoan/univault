import { UnivaultError } from "../errors";
import type { GitHubClient } from "../github/client";
import type { UnivaultSettings } from "../settings";
import type { IndexEntry, StateStore, SyncAnchor } from "../store/db";
import { download } from "../transfer/download";
import { bootstrapBranch, uploadBlob } from "../transfer/upload";
import type { VaultAdapter } from "../vault/adapter";
import { canonicalizeRepoPath } from "../vault/paths";
import { classifyAll } from "./classify";
import { commitMessage, createSyncCommit } from "./commit";
import { type LocalChange, type LocalScan, localDelta } from "./local-delta";
import { type RemoteChange, checkHead, remoteDelta } from "./remote-delta";

export type SyncState = "idle" | "syncing" | "error";

export type SyncOutcome =
	| { kind: "synced"; uploaded: number; downloaded: number }
	| { kind: "remote-empty" }
	| { kind: "needs-setup" }
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
		const check = await checkHead(client, repository, branch, anchor);
		if (check.kind === "empty") {
			// Only a never-synced vault seeds an empty repository; with an anchor it was emptied behind us.
			if (anchor || bootstrapped) throw new UnivaultError("not-found", { cause: new Error("Repository is empty") });
			return this.bootstrap(context, index);
		}
		let head = anchor ? { commitSha: anchor.commitSha, treeSha: anchor.treeSha } : null;
		let remote = new Map<string, RemoteChange>();
		if (check.kind === "changed") {
			head = { commitSha: check.sha, treeSha: (await client.getCommit(repository, check.sha)).treeSha };
			const canonical = (path: string) => canonicalizeRepoPath(path, this.deps.configDir, this.deps.pluginDir);
			remote = await remoteDelta(client, repository, anchor, head, index, canonical);
		}
		if (!head) throw new UnivaultError("unknown", { cause: new Error("No head without an anchor") });

		const scan = await this.scan(index);
		const local = scan.changes;
		const outcomes = classifyAll(local, remote);
		const conflicts = [...outcomes].filter(([, o]) => o === "conflict").map(([path]) => path);
		if (conflicts.length) throw new UnivaultError("conflict-retry", { paths: conflicts.sort() });

		const indexed = sameOnBothSides(outcomes, local, remote);
		const downloads = [...outcomes].filter(([, o]) => o === "download").map(([path]) => path);
		for (const path of downloads) {
			// Expected stat: the scan's for listed files, else the one recorded at the last download
			// (dot-prefixed paths, case-only collisions). A file on disk in neither conflicts.
			// A path missing from disk was deleted locally: nothing to lose, phase 0 restores it.
			const seen = scan.files.get(path) ?? index.get(path) ?? null;
			const present = seen !== null && (scan.files.has(path) || (await vault.stat(path)) !== null);
			const expected = seen && present ? { mtime: seen.mtime, size: seen.size } : null;
			await download(client, repository, vault, path, (remote.get(path) as { sha: string }).sha, expected);
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
		const refEtag = await this.etagFor(client, repository, branch, commit.commitSha);
		await store.advance({ repository, branch, ...commit, refEtag }, [...entries, ...indexed]);
		return { kind: "synced", uploaded: entries.length, downloaded: downloads.length };
	}

	// Over-cap files fail the sync by name, as an upload of them would.
	private async scan(index: Map<string, IndexEntry>): Promise<LocalScan> {
		const scan = await localDelta(this.deps.vault, index, this.deps.uploadCapBytes);
		if (scan.oversized.length) {
			throw new UnivaultError("unknown", { cause: new Error("Files over the upload cap"), paths: scan.oversized });
		}
		return scan;
	}

	// The ETag makes the next unchanged head check a free 304. It is kept only if the ref
	// still points at our commit; an ETag for someone else's newer push would hide it.
	private async etagFor(client: GitHubClient, repository: string, branch: string, sha: string): Promise<string | null> {
		try {
			const ref = await client.getRef(repository, branch);
			return ref.kind === "found" && ref.sha === sha ? ref.etag : null;
		} catch {
			return null;
		}
	}

	// The repository has no commits: git data refuses every write, so the first file goes
	// through the contents api, which creates the branch with a root commit.
	private async bootstrap(context: Context, index: Map<string, IndexEntry>): Promise<SyncOutcome | "rejected"> {
		const { client, login, settings } = context;
		const { changes: local } = await this.scan(index);
		const files = [...local].filter(([, c]) => c.kind !== "deleted").sort(([a], [b]) => (a < b ? -1 : 1));
		if (files.length === 0) return { kind: "remote-empty" };

		const [path, change] = files[0] as [string, Extract<LocalChange, { vaultPath: string }>];
		const message = commitMessage(settings.deviceName, login);
		const file = { path, ...change };
		const { repository, branch } = settings;
		await bootstrapBranch(client, repository, branch, this.deps.vault, file, this.deps.uploadCapBytes, message);
		const rest = await this.cycle(context, true);
		return rest !== "rejected" && rest.kind === "synced" ? { ...rest, uploaded: rest.uploaded + 1 } : rest;
	}

	private async downloadedEntries(paths: string[], remote: Map<string, RemoteChange>): Promise<IndexEntry[]> {
		const entries: IndexEntry[] = [];
		for (const path of paths) {
			const stat = await this.deps.vault.stat(path);
			if (!stat) throw new UnivaultError("unknown", { cause: new Error("Downloaded file is missing"), paths: [path] });
			const sha = (remote.get(path) as { sha: string }).sha;
			entries.push({ path, mtime: stat.mtime, size: stat.size, blobSha: sha, mode: FILE_MODE });
		}
		return entries;
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
