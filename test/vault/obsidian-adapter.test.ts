import { describe, expect, it } from "vitest";
import { ObsidianVaultAdapter, TEMP_SUFFIX } from "../../src/vault/obsidian-adapter";
import { FakeVault } from "../fakes/vault";

function streamOf(chunks: Uint8Array[], failAfter?: number): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (failAfter !== undefined && i === failAfter) controller.error(new Error("network dropped"));
			else if (i < chunks.length) controller.enqueue(chunks[i++]);
			else controller.close();
		},
	});
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("ObsidianVaultAdapter.writeChunked", () => {
	it("appends each chunk to a temp file and moves it into a new folder", async () => {
		const vault = new FakeVault();
		const adapter = new ObsidianVaultAdapter(vault);

		await adapter.writeChunked("a/b/note.md", streamOf([enc("line 1\r\n"), enc("line 2\r\n")]));

		expect(new TextDecoder().decode(vault.bytes("a/b/note.md"))).toBe("line 1\r\nline 2\r\n");
		expect(vault.appendCalls).toEqual([`a/b/note.md${TEMP_SUFFIX}`, `a/b/note.md${TEMP_SUFFIX}`]);
		expect(vault.files.has(`a/b/note.md${TEMP_SUFFIX}`)).toBe(false);
	});

	it("replaces an existing file", async () => {
		const vault = new FakeVault();
		vault.setFile("note.md", "old");
		await new ObsidianVaultAdapter(vault).writeChunked("note.md", streamOf([enc("new")]));
		expect(new TextDecoder().decode(vault.bytes("note.md"))).toBe("new");
	});

	it("leaves the target untouched when the stream fails, and the temp file goes on cleanup", async () => {
		const vault = new FakeVault();
		vault.setFile("note.md", "original");
		const adapter = new ObsidianVaultAdapter(vault);

		await expect(adapter.writeChunked("note.md", streamOf([enc("par"), enc("tial")], 1))).rejects.toThrow(
			"network dropped",
		);
		expect(new TextDecoder().decode(vault.bytes("note.md"))).toBe("original");
		expect((await adapter.list()).map((f) => f.path)).toEqual(["note.md"]);

		await adapter.removeTempFiles();
		expect([...vault.files.keys()]).toEqual(["note.md"]);
	});
});
