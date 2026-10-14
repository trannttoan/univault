import { UnivaultError } from "../errors";
import type { GitHubClient } from "../github/client";
import type { UnivaultSettings } from "../settings";
import type { StateStore } from "../store/db";
import type { VaultAdapter } from "../vault/adapter";
import { classifyAll } from "./classify";
import { localDelta } from "./local-delta";
import { checkHead } from "./remote-delta";

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
}

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

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
			return await this.run();
		} catch (error) {
			return {
				kind: "failed",
				error: error instanceof UnivaultError ? error : new UnivaultError("unknown", { cause: error }),
			};
		}
	}

	private async run(): Promise<SyncOutcome> {
		const { store, vault } = this.deps;
		const session = this.deps.session();
		const { repository, branch } = this.deps.settings();
		if (!session || !REPOSITORY.test(repository) || !branch) return { kind: "needs-setup" };

		await vault.removeTempFiles();
		let anchor = await store.getAnchor();
		if (anchor && (anchor.repository !== repository || anchor.branch !== branch)) {
			await store.discardAnchor();
			anchor = null;
		}

		const head = await checkHead(session.client, repository, branch, anchor);
		if (head.kind === "changed" || !anchor) throw notYet("downloading remote changes");

		const local = await localDelta(vault, await store.getIndex());
		const outcomes = classifyAll(local, new Map());
		if ([...outcomes.values()].some((outcome) => outcome !== "noop")) throw notYet("uploading local changes");

		if (head.etag !== anchor.refEtag) await store.advance({ ...anchor, refEtag: head.etag }, []);
		return { kind: "synced", uploaded: 0, downloaded: 0 };
	}

	private setState(state: SyncState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}

// Transitional: transfers arrive with the upload and download slices.
function notYet(what: string): UnivaultError {
	return new UnivaultError("unknown", { cause: new Error(`Not implemented yet: ${what}`) });
}
