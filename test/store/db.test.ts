import { describe, expect, it } from "vitest";
import { UnivaultError } from "../../src/errors";
import { type IndexEntry, SCHEMA_VERSION, type Snapshot, StateStore, type SyncAnchor } from "../../src/store/db";

const anchor: SyncAnchor = {
	repository: "owner/vault",
	branch: "main",
	commitSha: "c".repeat(40),
	treeSha: "t".repeat(40),
	refEtag: 'W/"abc"',
};

const entry: IndexEntry = { path: "note.md", mtime: 1, size: 5, blobSha: "b".repeat(40), mode: "100644" };

describe("StateStore", () => {
	it("keeps anchor and index across close and reopen", async () => {
		const vaultId = crypto.randomUUID();
		const store = await StateStore.open(vaultId);
		await store.advance(anchor, [entry]);
		store.close();

		const reopened = await StateStore.open(vaultId);
		expect(await reopened.getAnchor()).toEqual(anchor);
		expect(await reopened.getIndex()).toEqual(new Map([["note.md", entry]]));
		reopened.close();
	});

	it("starts empty", async () => {
		const store = await StateStore.open(crypto.randomUUID());
		expect(await store.getAnchor()).toBeNull();
		expect((await store.getIndex()).size).toBe(0);
		store.close();
	});

	it("writes nothing when an index write fails after the anchor write", async () => {
		const store = await StateStore.open(crypto.randomUUID());
		const invalid = { ...entry, path: undefined } as unknown as IndexEntry;

		await expect(store.advance(anchor, [entry, invalid])).rejects.toMatchObject({ code: "unknown" });
		expect(await store.getAnchor()).toBeNull();
		expect((await store.getIndex()).size).toBe(0);
		store.close();
	});

	it("clears anchor and index on discard", async () => {
		const store = await StateStore.open(crypto.randomUUID());
		await store.advance(anchor, [entry]);
		await store.discardAnchor();
		expect(await store.getAnchor()).toBeNull();
		expect((await store.getIndex()).size).toBe(0);
		store.close();
	});

	it("refuses a database with a newer schema", async () => {
		const vaultId = crypto.randomUUID();
		await new Promise<void>((resolve) => {
			const req = indexedDB.open(`univault-${vaultId}`, SCHEMA_VERSION + 1);
			req.onsuccess = () => {
				req.result.close();
				resolve();
			};
		});

		const error = await StateStore.open(vaultId).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(UnivaultError);
		expect((error as UnivaultError).code).toBe("unknown");
		expect(String((error as UnivaultError).cause)).toContain(`univault-${vaultId}`);
	});

	it("upgrades a version 1 database to version 2, keeping anchor and index", async () => {
		const vaultId = crypto.randomUUID();
		// The version 1 layout, as release 0.1.x created it.
		await new Promise<void>((resolve) => {
			const req = indexedDB.open(`univault-${vaultId}`, 1);
			req.onupgradeneeded = () => {
				req.result.createObjectStore("anchor");
				req.result.createObjectStore("index", { keyPath: "path" });
			};
			req.onsuccess = () => {
				const tx = req.result.transaction(["anchor", "index"], "readwrite");
				tx.objectStore("anchor").put(anchor, "current");
				tx.objectStore("index").put(entry);
				tx.oncomplete = () => {
					req.result.close();
					resolve();
				};
			};
		});

		const upgraded = await StateStore.open(vaultId);
		expect(await upgraded.getAnchor()).toEqual(anchor);
		expect(await upgraded.getIndex()).toEqual(new Map([["note.md", entry]]));
		expect(await upgraded.getConflicts()).toEqual([]);
		expect(await upgraded.getSnapshots()).toEqual([]);
		upgraded.close();

		const freshId = crypto.randomUUID();
		(await StateStore.open(freshId)).close();
		const shape = await layout(`univault-${vaultId}`);
		expect(shape).toMatchObject({ version: SCHEMA_VERSION, stores: { length: 4 } });
		expect(shape).toEqual(await layout(`univault-${freshId}`));
	});

	it("finds a snapshot by path and fields, including a null base, and prunes old ones except those kept", async () => {
		const store = await StateStore.open(crypto.randomUUID());
		const snapshot = (id: string, createdAt: string): Snapshot => ({
			id,
			path: "note.md",
			bytes: new Uint8Array([1, 2]),
			blobSha: "e".repeat(40),
			baseSha: "b".repeat(40),
			createdAt,
			reason: "pre-merge",
		});
		await store.putSnapshot(snapshot("old", "2026-01-01T00:00:00.000Z"));
		await store.putSnapshot(snapshot("kept", "2026-01-02T00:00:00.000Z"));
		await store.putSnapshot(snapshot("new", "2026-03-01T00:00:00.000Z"));

		expect((await store.findSnapshot("note.md", { reason: "pre-merge", baseSha: "b".repeat(40) }))?.bytes).toEqual(new Uint8Array([1, 2]));
		expect(await store.findSnapshot("note.md", { reason: "conflict-local" })).toBeNull();
		await store.putSnapshot({ ...snapshot("added", "2026-03-02T00:00:00.000Z"), baseSha: null, reason: "conflict-local" });
		expect((await store.findSnapshot("note.md", { reason: "conflict-local", baseSha: null }))?.id).toBe("added");
		expect(await store.findSnapshot("other.md", {})).toBeNull();
		await store.pruneSnapshots("2026-02-01T00:00:00.000Z", new Set(["kept"]));
		expect((await store.getSnapshots()).map((s) => s.id).sort()).toEqual(["added", "kept", "new"]);
		store.close();
	});
});

// Store names with their key paths and indexes, for comparing two databases' shapes.
function layout(name: string): Promise<unknown> {
	return new Promise((resolve) => {
		const req = indexedDB.open(name);
		req.onsuccess = () => {
			const db = req.result;
			const stores = Array.from(db.objectStoreNames).map((store) => {
				const os = db.transaction(store, "readonly").objectStore(store);
				const indexes = Array.from(os.indexNames).map((i) => [i, os.index(i).keyPath]);
				return [store, os.keyPath, indexes];
			});
			resolve({ version: db.version, stores });
			db.close();
		};
	});
}
