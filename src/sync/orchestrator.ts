import { UnivaultError } from "../errors";
import type { GitHubClient } from "../github/client";
import type { UnivaultSettings } from "../settings";
import type { IndexEntry, StateStore, SyncAnchor } from "../store/db";
import { uploadBlob } from "../transfer/upload";
import type { VaultAdapter } from "../vault/adapter";
import { classifyAll } from "./classify";
import { commitMessage, createSyncCommit } from "./commit";
import { type LocalChange, localDelta } from "./local-delta";
import { type RemoteChange, checkHead } from "./remote-delta";

export type SyncState = "idle" | "syncing" | "error";

export type SyncOutcome =
	| { kind: "synced"; uploaded: number; downloaded: number }
	| { kind: "needs-setup" }
	| { kind: "failed"; error: UnivaultError };

export interface OrchestratorDeps {
	session(): { client: GitHubClient; login: string } | null;
	settings(): UnivaultSettings;
	store: StateStore;
	vault: VaultAdapter;
	uploadCapBytes: number;
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
			if (outcome.kind === "synced") this.lastSyncAt = new Date();
			this.setState(outcome.kind === "synced" ? "idle" : "error");
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

	private async cycle({ client, login, settings }: Context): Promise<SyncOutcome | "rejected"> {
		const { store, vault } = this.deps;
		const { repository, branch } = settings;

		let anchor = await store.getAnchor();
		if (anchor && (anchor.repository !== repository || anchor.branch !== branch)) {
			await store.discardAnchor();
			anchor = null;
		}
		if (!anchor) throw notYet("first sync without an anchor");

		let head = { commitSha: anchor.commitSha, treeSha: anchor.treeSha };
		let remote = new Map<string, RemoteChange>();
		const check = await checkHead(client, repository, branch, anchor);
		if (check.kind === "changed") {
			head = { commitSha: check.sha, treeSha: (await client.getCommit(repository, check.sha)).treeSha };
			remote = await this.compare(client, repository, anchor, check.sha);
		}

		const local = await localDelta(vault, await store.getIndex());
		const outcomes = classifyAll(local, remote);
		const conflicts = [...outcomes].filter(([, o]) => o === "conflict").map(([path]) => path);
		if (conflicts.length) throw new UnivaultError("conflict-retry", { paths: conflicts.sort() });
		if ([...outcomes.values()].includes("download")) throw notYet("downloading remote changes");

		const uploads = [...outcomes].filter(([, o]) => o === "upload").map(([path]) => path);
		const indexed = sameOnBothSides(outcomes, local, remote);

		if (uploads.length === 0) {
			const next: SyncAnchor = { ...anchor, ...head, refEtag: check.etag };
			if (check.kind === "changed" || check.etag !== anchor.refEtag || indexed.length) await store.advance(next, indexed);
			return { kind: "synced", uploaded: 0, downloaded: 0 };
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
		return { kind: "synced", uploaded: entries.length, downloaded: 0 };
	}

	private async compare(
		client: GitHubClient,
		repository: string,
		anchor: SyncAnchor,
		headSha: string,
	): Promise<Map<string, RemoteChange>> {
		const { files } = await client.getCompare(repository, anchor.commitSha, headSha);
		const remote = new Map<string, RemoteChange>();
		for (const file of files) {
			if (file.status === "added" || file.status === "modified") {
				remote.set(file.filename, { kind: file.status, sha: file.sha });
			}
		}
		return remote;
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

// Transitional: downloads and first sync arrive with the next slices.
function notYet(what: string): UnivaultError {
	return new UnivaultError("unknown", { cause: new Error(`Not implemented yet: ${what}`) });
}
