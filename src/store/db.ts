import { UnivaultError } from "../errors";

export const SCHEMA_VERSION = 2;

export interface SyncAnchor {
	repository: string;
	branch: string;
	commitSha: string;
	treeSha: string;
	refEtag: string | null;
}

export interface IndexEntry {
	path: string;
	mtime: number;
	size: number;
	blobSha: string;
	mode: string;
}

export interface Snapshot {
	id: string;
	path: string;
	bytes: Uint8Array;
	blobSha: string;
	// The index blob the snapshot was taken against; null when the path had none.
	baseSha: string | null;
	createdAt: string;
	reason: "pre-merge" | "conflict-local";
}

export interface PendingConflict {
	path: string;
	kind: "text-overlap" | "binary" | "delete-vs-modify";
	baseSha: string | null;
	remoteSha: string;
	remoteDevice: string;
	// The GitHub login in the device trailer; device names are self-chosen, so the picker shows both.
	remoteLogin: string | null;
	remoteTime: string;
	localSha: string;
	localStat: { mtime: number; size: number };
	localSnapshotId: string | null;
	choice: "mine" | "theirs" | "both" | null;
	// Where keep both writes theirs; chosen once, so a retried sync reuses it.
	siblingPath: string | null;
}

const ANCHOR = "anchor";
const INDEX = "index";
const SNAPSHOTS = "snapshots";
const CONFLICTS = "conflicts";
const ANCHOR_KEY = "current";
const BY_PATH = "by-path";
const BY_CREATED = "by-created";

export class StateStore {
	private constructor(private readonly db: IDBDatabase) {}

	static open(vaultId: string): Promise<StateStore> {
		const name = `univault-${vaultId}`;
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(name, SCHEMA_VERSION);
			// Forward-only: each step brings an older layout up by one version.
			req.onupgradeneeded = (event) => {
				const db = req.result;
				if (event.oldVersion < 1) {
					db.createObjectStore(ANCHOR);
					db.createObjectStore(INDEX, { keyPath: "path" });
				}
				if (event.oldVersion < 2) {
					const snapshots = db.createObjectStore(SNAPSHOTS, { keyPath: "id" });
					snapshots.createIndex(BY_PATH, "path");
					snapshots.createIndex(BY_CREATED, "createdAt");
					db.createObjectStore(CONFLICTS, { keyPath: "path" });
				}
			};
			req.onsuccess = () => resolve(new StateStore(req.result));
			req.onerror = () => {
				if (req.error?.name === "VersionError") {
					const cause = new Error(`IndexedDB schema of ${name} is newer than version ${SCHEMA_VERSION}`, {
						cause: req.error,
					});
					reject(new UnivaultError("unknown", { cause }));
				} else {
					reject(storageError(req.error));
				}
			};
		});
	}

	close(): void {
		this.db.close();
	}

	async getAnchor(): Promise<SyncAnchor | null> {
		const tx = this.db.transaction(ANCHOR, "readonly");
		const anchor = await request<SyncAnchor | undefined>(tx.objectStore(ANCHOR).get(ANCHOR_KEY));
		return anchor ?? null;
	}

	async getIndex(): Promise<Map<string, IndexEntry>> {
		const tx = this.db.transaction(INDEX, "readonly");
		const entries = await request<IndexEntry[]>(tx.objectStore(INDEX).getAll());
		return new Map(entries.map((entry) => [entry.path, entry]));
	}

	// Anchor, index entries and conflict records commit together or not at all.
	advance(
		anchor: SyncAnchor,
		entries: IndexEntry[],
		conflicts: { put?: PendingConflict[]; remove?: string[] } = {},
	): Promise<void> {
		const tx = this.db.transaction([ANCHOR, INDEX, CONFLICTS], "readwrite");
		const finished = done(tx);
		try {
			tx.objectStore(ANCHOR).put(anchor, ANCHOR_KEY);
			const index = tx.objectStore(INDEX);
			for (const entry of entries) index.put(entry);
			const records = tx.objectStore(CONFLICTS);
			for (const path of conflicts.remove ?? []) records.delete(path);
			for (const record of conflicts.put ?? []) records.put(record);
		} catch (error) {
			tx.abort();
			finished.catch(() => {});
			return Promise.reject(storageError(error));
		}
		return finished;
	}

	async getConflicts(): Promise<PendingConflict[]> {
		const tx = this.db.transaction(CONFLICTS, "readonly");
		return request<PendingConflict[]>(tx.objectStore(CONFLICTS).getAll());
	}

	putConflict(conflict: PendingConflict): Promise<void> {
		const tx = this.db.transaction(CONFLICTS, "readwrite");
		tx.objectStore(CONFLICTS).put(conflict);
		return done(tx);
	}

	// Read and write in one transaction, so a sync refreshing the record cannot interleave.
	async answerConflict(path: string, remoteSha: string, choice: NonNullable<PendingConflict["choice"]>): Promise<boolean> {
		const tx = this.db.transaction(CONFLICTS, "readwrite");
		const store = tx.objectStore(CONFLICTS);
		const record = await request<PendingConflict | undefined>(store.get(path));
		const current = record?.remoteSha === remoteSha;
		if (record && current) store.put({ ...record, choice });
		await done(tx);
		return current;
	}

	putSnapshot(snapshot: Snapshot): Promise<void> {
		const tx = this.db.transaction(SNAPSHOTS, "readwrite");
		tx.objectStore(SNAPSHOTS).put(snapshot);
		return done(tx);
	}

	deleteSnapshot(id: string): Promise<void> {
		const tx = this.db.transaction(SNAPSHOTS, "readwrite");
		tx.objectStore(SNAPSHOTS).delete(id);
		return done(tx);
	}

	async getSnapshot(id: string): Promise<Snapshot | null> {
		const tx = this.db.transaction(SNAPSHOTS, "readonly");
		return (await request<Snapshot | undefined>(tx.objectStore(SNAPSHOTS).get(id))) ?? null;
	}

	// The first snapshot of `path` whose fields equal those in `match`; one held in memory at a time.
	findSnapshot(path: string, match: Partial<Pick<Snapshot, "reason" | "baseSha" | "blobSha">>): Promise<Snapshot | null> {
		const tx = this.db.transaction(SNAPSHOTS, "readonly");
		const cursor = tx.objectStore(SNAPSHOTS).index(BY_PATH).openCursor(IDBKeyRange.only(path));
		return new Promise((resolve, reject) => {
			cursor.onsuccess = () => {
				const current = cursor.result;
				if (!current) return resolve(null);
				const snapshot = current.value as Snapshot;
				const fits = Object.entries(match).every(([key, value]) => snapshot[key as keyof typeof match] === value);
				if (fits) resolve(snapshot);
				else current.continue();
			};
			cursor.onerror = () => reject(storageError(cursor.error));
		});
	}

	async getSnapshots(): Promise<Snapshot[]> {
		const tx = this.db.transaction(SNAPSHOTS, "readonly");
		return request<Snapshot[]>(tx.objectStore(SNAPSHOTS).getAll());
	}

	// Deletes snapshots created before `before` (ISO time), except the ids in `keep`.
	pruneSnapshots(before: string, keep: Set<string>): Promise<void> {
		const tx = this.db.transaction(SNAPSHOTS, "readwrite");
		const cursor = tx.objectStore(SNAPSHOTS).index(BY_CREATED).openCursor(IDBKeyRange.upperBound(before, true));
		cursor.onsuccess = () => {
			const current = cursor.result;
			if (!current) return;
			if (!keep.has((current.value as Snapshot).id)) current.delete();
			current.continue();
		};
		return done(tx);
	}

	// Conflicts belong to the anchor's repository; snapshots stay for their retention period.
	discardAnchor(): Promise<void> {
		const tx = this.db.transaction([ANCHOR, INDEX, CONFLICTS], "readwrite");
		tx.objectStore(ANCHOR).clear();
		tx.objectStore(INDEX).clear();
		tx.objectStore(CONFLICTS).clear();
		return done(tx);
	}
}

function storageError(cause: unknown): UnivaultError {
	const name = cause instanceof DOMException || cause instanceof Error ? cause.name : "";
	return new UnivaultError(name === "QuotaExceededError" ? "storage-full" : "unknown", { cause });
}

function request<T>(req: IDBRequest): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result as T);
		req.onerror = () => reject(storageError(req.error));
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(storageError(tx.error));
	});
}
