import { UnivaultError } from "../errors";

export const SCHEMA_VERSION = 1;

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

const ANCHOR = "anchor";
const INDEX = "index";
const ANCHOR_KEY = "current";

export class StateStore {
	private constructor(private readonly db: IDBDatabase) {}

	static open(vaultId: string): Promise<StateStore> {
		const name = `univault-${vaultId}`;
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(name, SCHEMA_VERSION);
			req.onupgradeneeded = () => {
				const db = req.result;
				db.createObjectStore(ANCHOR);
				db.createObjectStore(INDEX, { keyPath: "path" });
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

	// Anchor and index entries commit together or not at all.
	advance(anchor: SyncAnchor, entries: IndexEntry[]): Promise<void> {
		const tx = this.db.transaction([ANCHOR, INDEX], "readwrite");
		const finished = done(tx);
		try {
			tx.objectStore(ANCHOR).put(anchor, ANCHOR_KEY);
			const index = tx.objectStore(INDEX);
			for (const entry of entries) index.put(entry);
		} catch (error) {
			tx.abort();
			finished.catch(() => {});
			return Promise.reject(storageError(error));
		}
		return finished;
	}

	discardAnchor(): Promise<void> {
		const tx = this.db.transaction([ANCHOR, INDEX], "readwrite");
		tx.objectStore(ANCHOR).clear();
		tx.objectStore(INDEX).clear();
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
