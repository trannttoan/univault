import { describe, expect, it, vi } from "vitest";
import type { IndexEntry } from "../../src/store/db";
import { localDelta } from "../../src/sync/local-delta";
import { gitBlobSha } from "../../src/vault/hash";
import { ObsidianVaultAdapter } from "../../src/vault/obsidian-adapter";
import { FakeVault } from "../fakes/vault";

async function indexOf(vault: FakeVault): Promise<Map<string, IndexEntry>> {
	const index = new Map<string, IndexEntry>();
	for (const { path, stat } of vault.getFiles()) {
		const blobSha = await gitBlobSha(vault.bytes(path)!);
		index.set(path.normalize("NFC"), { path, mtime: stat.mtime, size: stat.size, blobSha, mode: "100644" });
	}
	return index;
}

describe("localDelta", () => {
	it("hashes nothing when mtime and size are unchanged", async () => {
		const vault = new FakeVault();
		vault.setFile("a.md", "a");
		vault.setFile("b.md", "b");
		const index = await indexOf(vault);
		const hash = vi.fn(gitBlobSha);

		const { changes: delta } = await localDelta(new ObsidianVaultAdapter(vault), index, hash);

		expect(delta.size).toBe(0);
		expect(hash).not.toHaveBeenCalled();
	});

	it("reports added, modified and deleted paths", async () => {
		const vault = new FakeVault();
		vault.setFile("keep.md", "same");
		vault.setFile("edit.md", "before");
		vault.setFile("gone.md", "bye");
		const index = await indexOf(vault);
		vault.setFile("edit.md", "after");
		vault.setFile("new.md", "hello");
		vault.files.delete("gone.md");

		const { changes: delta } = await localDelta(new ObsidianVaultAdapter(vault), index);

		expect(Object.fromEntries([...delta].map(([path, change]) => [path, change.kind]))).toEqual({
			"edit.md": "modified",
			"new.md": "added",
			"gone.md": "deleted",
		});
		expect(delta.get("new.md")).toMatchObject({ blobSha: "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0", size: 5 });
	});

	it("ignores a touched file whose content did not change", async () => {
		const vault = new FakeVault();
		vault.setFile("a.md", "same");
		const index = await indexOf(vault);
		vault.setFile("a.md", "same");

		expect((await localDelta(new ObsidianVaultAdapter(vault), index)).changes.size).toBe(0);
	});

	it("keys by NFC and reads by the vault's own spelling", async () => {
		const vault = new FakeVault();
		vault.setFile("cafe\u0301.md", "x");

		const { changes: delta } = await localDelta(new ObsidianVaultAdapter(vault), new Map());

		expect([...delta.keys()]).toEqual(["caf\u00e9.md"]);
		expect(delta.get("caf\u00e9.md")).toMatchObject({ kind: "added", vaultPath: "cafe\u0301.md" });
	});
});
