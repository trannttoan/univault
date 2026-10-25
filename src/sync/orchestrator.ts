import { UnivaultError } from "../errors";
import type { GitHubClient } from "../github/client";
import type { Commit } from "../github/types";
import type { UnivaultSettings } from "../settings";
import type { IndexEntry, PendingConflict, Snapshot, StateStore, SyncAnchor } from "../store/db";
import { MERGE_CAP_BYTES, type MergeResult, decodeText, isBinaryPath, merge } from "../merge/engine";
import { siblingPath } from "../merge/sibling";
import { download, readBlob, streamOf } from "../transfer/download";
import { bootstrapBranch, uploadBlob } from "../transfer/upload";
import type { VaultAdapter } from "../vault/adapter";
import { gitBlobSha } from "../vault/hash";
import { canonicalizeRepoPath } from "../vault/paths";
import { classifyAll } from "./classify";
import { type MergeTrailer, commitMessage, createSyncCommit, deviceTrailer } from "./commit";
import { type LocalChange, type LocalScan, localDelta } from "./local-delta";
import { type RemoteChange, checkHead, remoteDelta } from "./remote-delta";

export type SyncState = "idle" | "syncing" | "conflicts-pending" | "error";

export type SyncOutcome =
	// `merged`: paths merged from both sides and uploaded; `conflicts`: paths still waiting for
	// a choice after this sync. Each is present only when it has entries.
	| { kind: "synced"; uploaded: number; downloaded: number; merged?: string[]; conflicts?: string[] }
	| { kind: "remote-empty" }
	// No anchor yet, and these paths differ between the vault and the repository.
	| { kind: "first-sync-differs"; paths: string[] }
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
	now?: () => Date;
	// Per-side size above which a two-sided change goes to the picker unmerged.
	mergeCapBytes?: number;
}

interface Context {
	client: GitHubClient;
	login: string;
	settings: UnivaultSettings;
}

interface UploadFile {
	path: string;
	vaultPath: string;
	mtime: number;
	size: number;
}

type Changed = Extract<LocalChange, { vaultPath: string }>;

export type Choice = NonNullable<PendingConflict["choice"]>;

interface Merged {
	// The merge equals theirs: written locally, nothing to upload.
	downloaded: IndexEntry[];
	uploads: UploadFile[];
	trailers: MergeTrailer[];
	conflicts: PendingConflict[];
}

// What applying the recorded choices did, before the local scan.
interface Applied {
	// Index entries replacing the base for resolved paths.
	index: IndexEntry[];
	// Files written by a resolution, which the vault's file list may not show yet.
	added: Map<string, Changed>;
	resolved: string[];
}

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const MAX_REF_RETRIES = 3;
const FILE_MODE = "100644";
const SNAPSHOT_DAYS = 30;

export class Orchestrator {
	state: SyncState = "idle";
	lastSyncAt: Date | null = null;
	pendingConflicts = 0;
	private current: Promise<SyncOutcome> | null = null;
	private again = false;
	private readonly listeners: (() => void)[] = [];

	constructor(private readonly deps: OrchestratorDeps) {}

	onChange(listener: () => void): void {
		this.listeners.push(listener);
	}

	// Sorted by path. Also refreshes the pending count, e.g. after a restart, unless a sync
	// is running and will set it itself.
	async conflicts(): Promise<PendingConflict[]> {
		const records = await this.deps.store.getConflicts();
		if (this.state === "idle" || this.state === "conflicts-pending") {
			this.pendingConflicts = records.length;
			this.setState(records.length ? "conflicts-pending" : "idle");
		}
		return records;
	}

	// Stores the answer for the next sync to apply, which keeps the picker free of I/O. False
	// when theirs moved since the picker opened: the answer was about a version no longer there.
	recordChoice(conflict: Pick<PendingConflict, "path" | "remoteSha">, choice: Choice): Promise<boolean> {
		return this.deps.store.answerConflict(conflict.path, conflict.remoteSha, choice);
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
			if (outcome.kind === "synced") this.pendingConflicts = outcome.conflicts?.length ?? 0;
			this.setState(ok ? (this.pendingConflicts ? "conflicts-pending" : "idle") : "error");
		} while (this.again);
		return outcome;
	}

	private async runOnce(): Promise<SyncOutcome> {
		try {
			const session = this.deps.session();
			const settings = this.deps.settings();
			if (!session || !REPOSITORY.test(settings.repository) || !settings.branch) return { kind: "needs-setup" };
			await this.deps.vault.removeTempFiles();
			await this.pruneSnapshots();

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
		let headCommit: Commit | null = null;
		let remote = new Map<string, RemoteChange>();
		if (check.kind === "changed") {
			headCommit = await client.getCommit(repository, check.sha);
			head = { commitSha: check.sha, treeSha: headCommit.treeSha };
			const canonical = (path: string) => canonicalizeRepoPath(path, this.deps.configDir, this.deps.pluginDir);
			remote = await remoteDelta(client, repository, anchor, head, index, canonical);
		}
		if (!head) throw new UnivaultError("unknown", { cause: new Error("No head without an anchor") });

		// A pending path keeps its base index entry and is left out of classification until the
		// user's choice is applied; the rest of the vault syncs around it.
		// Theirs moved again since the picker was answered: the old answer no longer applies.
		const refreshed: PendingConflict[] = [];
		const records: PendingConflict[] = [];
		for (const record of await store.getConflicts()) {
			const change = remote.get(record.path);
			const moved = change !== undefined && change.kind !== "removed" && change.sha !== record.remoteSha;
			if (!moved || (await this.answerWritten(record))) {
				records.push(record);
				continue;
			}
			const update = { ...record, remoteSha: change.sha, ...remoteAuthor(headCommit), choice: null, siblingPath: null };
			refreshed.push(update);
			records.push(update);
		}
		const applied = await this.applyChoices(context, records, index, remote);
		const working = new Map(index);
		for (const entry of applied.index) working.set(entry.path, entry);
		const pending = records.filter((r) => !applied.resolved.includes(r.path));

		const scan = await this.scan(working);
		const local = scan.changes;
		for (const [path, change] of applied.added) local.set(path, change);
		for (const { path } of pending) {
			local.delete(path);
			remote.delete(path);
		}
		const outcomes = classifyAll(local, remote, working);
		// Without an anchor every difference is base-less; a picker per file is the wrong tool
		// for a vault being joined to a populated repository, so that sync still refuses.
		const conflicts = [...outcomes].filter(([, o]) => o === "conflict").map(([path]) => path);
		if (conflicts.length && !anchor) return { kind: "first-sync-differs", paths: conflicts.sort() };

		const merged = await this.merge(context, outcomes, local, remote, working, headCommit);
		const indexed = [...applied.index, ...sameOnBothSides(outcomes, local, remote), ...merged.downloaded];
		const recordChanges = { put: [...refreshed, ...merged.conflicts], remove: applied.resolved };
		const stillPending = [...pending, ...merged.conflicts].map((r) => r.path).sort();
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
		const downloaded = downloads.length + merged.downloaded.length;

		const uploads: UploadFile[] = [...outcomes]
			.filter(([, o]) => o === "upload")
			.map(([path]) => ({ path, ...(local.get(path) as Changed) }));
		const result = (uploaded: number) => ({
			kind: "synced" as const,
			uploaded,
			downloaded,
			...(merged.uploads.length ? { merged: merged.uploads.map((u) => u.path) } : {}),
			...(stillPending.length ? { conflicts: stillPending } : {}),
		});
		if (uploads.length + merged.uploads.length === 0) {
			const next: SyncAnchor = { repository, branch, ...head, refEtag: check.etag };
			const changed = check.kind === "changed" || check.etag !== anchor?.refEtag || indexed.length || applied.resolved.length;
			if (changed) await store.advance(next, indexed, recordChanges);
			return result(0);
		}

		const entries: IndexEntry[] = [];
		for (const file of [...uploads, ...merged.uploads]) {
			const blob = await uploadBlob(client, repository, vault, file, this.deps.uploadCapBytes);
			entries.push({ path: file.path, mtime: file.mtime, size: blob.size, blobSha: blob.sha, mode: FILE_MODE });
		}
		const tree = entries.map((e) => ({ path: e.path, mode: FILE_MODE, type: "blob", sha: e.blobSha }) as const);
		const message = commitMessage(settings.deviceName, login, merged.trailers);
		const commit = await createSyncCommit(client, repository, head, tree, message);

		try {
			await client.updateRef(repository, branch, commit.commitSha);
		} catch (error) {
			if (error instanceof UnivaultError && error.code === "conflict-retry") return "rejected";
			throw error;
		}
		const refEtag = await this.etagFor(client, repository, branch, commit.commitSha);
		// Later entries win: an upload replaces a resolution's placeholder entry for the same path.
		await store.advance({ repository, branch, ...commit, refEtag }, [...indexed, ...entries], recordChanges);
		return result(uploads.length);
	}

	// Writes each merge result over ours, guarded by the scan's stat. A result equal to ours (a
	// retry after the merged bytes landed) is not rewritten; one equal to theirs is a download.
	private async merge(
		context: Context,
		outcomes: Map<string, string>,
		local: Map<string, LocalChange>,
		remote: Map<string, RemoteChange>,
		index: Map<string, IndexEntry>,
		headCommit: Commit | null,
	): Promise<Merged> {
		const { client, settings } = context;
		const { vault } = this.deps;
		const merged: Merged = { downloaded: [], uploads: [], trailers: [], conflicts: [] };
		const cap = this.deps.mergeCapBytes ?? MERGE_CAP_BYTES;
		const paths = [...outcomes].filter(([, o]) => o === "merge" || o === "conflict").map(([path]) => path);
		for (const path of paths.sort()) {
			const ours = local.get(path) as Changed;
			const theirs = (remote.get(path) as { sha: string }).sha;
			const base = index.get(path)?.blobSha ?? null;
			// Over the cap nothing is read: ours stays on disk untouched until the user answers.
			const oursBytes = ours.size <= cap ? await vault.read(ours.vaultPath) : null;
			let result: MergeResult;
			if (isBinaryPath(path) || (oursBytes && decodeText(oursBytes) === null)) result = { kind: "conflict", detail: "binary" };
			else if (!oursBytes) result = { kind: "conflict", detail: "too-large" };
			// Added on both sides: no base to merge against, so the user decides.
			else if (base === null) result = { kind: "conflict", detail: "overlap" };
			else {
				const baseBytes = await readBlob(client, settings.repository, base, cap);
				const theirsBytes = baseBytes && (await readBlob(client, settings.repository, theirs, cap));
				result =
					baseBytes && theirsBytes ? merge(baseBytes, oursBytes, theirsBytes, path) : { kind: "conflict", detail: "too-large" };
			}
			if (result.kind === "conflict") {
				const snapshotId = oursBytes && (await this.conflictSnapshot(path, oursBytes, ours.blobSha, base));
				merged.conflicts.push({
					path,
					kind: result.detail === "binary" ? "binary" : "text-overlap",
					baseSha: base,
					remoteSha: theirs,
					...remoteAuthor(headCommit),
					localSha: ours.blobSha,
					localStat: { mtime: ours.mtime, size: ours.size },
					localSnapshotId: snapshotId,
					choice: null,
					siblingPath: null,
				});
				continue;
			}

			// One snapshot per (path, base): a retry after the merged bytes landed must keep
			// the original, not snapshot the merge, and the trailer names that original.
			const snapshot = await this.deps.store.findSnapshot(path, { reason: "pre-merge", baseSha: base });
			const sha = await gitBlobSha(result.bytes);
			let stat = { mtime: ours.mtime, size: ours.size };
			if (sha !== ours.blobSha) {
				const taken = snapshot ? null : await this.snapshot(path, oursBytes as Uint8Array, ours.blobSha, base, "pre-merge");
				try {
					await vault.writeChunked(ours.vaultPath, streamOf(result.bytes), stat);
				} catch (error) {
					// Refused before touching the note, which the user changed: the retry snapshots that version.
					const refused = error instanceof UnivaultError && error.code === "conflict-retry";
					if (taken && refused) await this.deps.store.deleteSnapshot(taken);
					throw error;
				}
				stat = await this.statWritten(path, ours.vaultPath);
			}
			if (sha === theirs) {
				merged.downloaded.push({ path, ...stat, blobSha: sha, mode: FILE_MODE });
			} else {
				merged.uploads.push({ path, vaultPath: ours.vaultPath, ...stat });
				merged.trailers.push({ path, base: base as string, ours: snapshot?.blobSha ?? ours.blobSha, theirs });
			}
		}
		return merged;
	}

	// Writes what each chosen resolution needs on disk before the scan. Keep mine and keep both
	// point the index at theirs, so the scan reads ours as a change to upload over it.
	private async applyChoices(
		context: Context,
		records: PendingConflict[],
		index: Map<string, IndexEntry>,
		remote: Map<string, RemoteChange>,
	): Promise<Applied> {
		const { client, settings } = context;
		const { store, vault } = this.deps;
		const applied: Applied = { index: [], added: new Map(), resolved: [] };
		for (const record of records) {
			const theirs = { path: record.path, mtime: 0, size: 0, blobSha: record.remoteSha, mode: FILE_MODE };
			if (record.choice === "mine") {
				applied.index.push(theirs);
				applied.resolved.push(record.path);
				continue;
			}
			if (record.choice === "theirs") {
				const entry = await this.keepTheirs(context, record);
				if (entry) {
					applied.index.push(entry);
					applied.resolved.push(record.path);
				}
				continue;
			}
			if (record.choice !== "both") continue;
			let sibling = record.siblingPath;
			if (!sibling) {
				for (let n = 1; !sibling; n++) {
					const candidate = siblingPath(record.path, record.remoteDevice, this.now(), n);
					const taken = index.has(candidate) || remote.has(candidate) || (await vault.exists(candidate));
					if (!taken) sibling = candidate;
				}
				await store.putConflict({ ...record, siblingPath: sibling });
			}
			let blobSha = record.remoteSha;
			if (await vault.exists(sibling)) blobSha = await gitBlobSha(await vault.read(sibling));
			else await download(client, settings.repository, vault, sibling, record.remoteSha, null);
			const stat = await this.statWritten(sibling, sibling);
			applied.added.set(sibling, { kind: "added", vaultPath: sibling, blobSha, ...stat });
			applied.index.push(theirs);
			applied.resolved.push(record.path);
		}
		return applied;
	}

	// Keep theirs or keep both already wrote the theirs the user saw. Asking again would lose
	// ours from disk, so that answer is finished and the newer theirs syncs as a normal change.
	private async answerWritten(record: PendingConflict): Promise<boolean> {
		const { vault } = this.deps;
		if (record.choice === "both") return record.siblingPath !== null && (await vault.exists(record.siblingPath));
		if (record.choice !== "theirs" || !(await vault.stat(record.path))) return false;
		return (await gitBlobSha(await vault.read(record.path))) === record.remoteSha;
	}

	// Replaces ours with theirs only if ours is still what the user saw in the picker. If it was
	// edited since, the choice is dropped and the conflict asks again about the new version.
	private async keepTheirs(context: Context, record: PendingConflict): Promise<IndexEntry | null> {
		const { store, vault } = this.deps;
		const { path, remoteSha } = record;
		const current = await vault.stat(path);
		const unchanged = current?.mtime === record.localStat.mtime && current.size === record.localStat.size;
		if (current && !unchanged) {
			const bytes = await vault.read(path);
			const sha = await gitBlobSha(bytes);
			// Theirs already landed: a retry after the push failed.
			if (sha === remoteSha) return { path, ...current, blobSha: sha, mode: FILE_MODE };
			// Same bytes with a new mtime is not an edit.
			if (sha !== record.localSha) {
				const localSnapshotId = await this.conflictSnapshot(path, bytes, sha, record.baseSha);
				await store.putConflict({ ...record, choice: null, localSha: sha, localStat: current, localSnapshotId });
				return null;
			}
		}
		await download(context.client, context.settings.repository, vault, path, remoteSha, current);
		return { path, ...(await this.statWritten(path, path)), blobSha: remoteSha, mode: FILE_MODE };
	}

	private async snapshot(
		path: string,
		bytes: Uint8Array,
		blobSha: string,
		baseSha: string | null,
		reason: Snapshot["reason"],
	): Promise<string> {
		const id = crypto.randomUUID();
		const createdAt = this.now().toISOString();
		await this.deps.store.putSnapshot({ id, path, bytes, blobSha, baseSha, createdAt, reason });
		return id;
	}

	// A retried cycle or a failed sync detects the same conflict again; it reuses the one copy.
	private async conflictSnapshot(path: string, bytes: Uint8Array, blobSha: string, baseSha: string | null): Promise<string> {
		const existing = await this.deps.store.findSnapshot(path, { reason: "conflict-local", baseSha, blobSha });
		return existing?.id ?? this.snapshot(path, bytes, blobSha, baseSha, "conflict-local");
	}

	// Snapshots a pending conflict still points at are kept past the retention period.
	private async pruneSnapshots(): Promise<void> {
		const { store } = this.deps;
		const keep = new Set((await store.getConflicts()).map((c) => c.localSnapshotId).filter((id) => id !== null));
		const before = new Date(this.now().getTime() - SNAPSHOT_DAYS * 24 * 60 * 60 * 1000);
		await store.pruneSnapshots(before.toISOString(), keep);
	}

	private now(): Date {
		return this.deps.now?.() ?? new Date();
	}

	private async statWritten(path: string, vaultPath: string): Promise<{ mtime: number; size: number }> {
		const stat = await this.deps.vault.stat(vaultPath);
		if (!stat) throw new UnivaultError("unknown", { cause: new Error("Written file is missing"), paths: [path] });
		return stat;
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
			const stat = await this.statWritten(path, path);
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

// "Who and when" for a conflict, from the head commit: its device trailer, else its author.
// Wrong when several devices pushed since the anchor; device manifests revisit this.
function remoteAuthor(commit: Commit | null): Pick<PendingConflict, "remoteDevice" | "remoteLogin" | "remoteTime"> {
	const trailer = commit && deviceTrailer(commit.message);
	return {
		remoteDevice: trailer?.device || commit?.author.name || "another device",
		remoteLogin: trailer?.login ?? null,
		remoteTime: commit?.author.date ?? "",
	};
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
