import { describe, expect, it } from "vitest";
import { UnivaultError } from "../../src/errors";
import { type IndexEntry, StateStore, type SyncAnchor } from "../../src/store/db";

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
			const req = indexedDB.open(`univault-${vaultId}`, 2);
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
});
