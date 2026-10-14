import { describe, expect, it, vi } from "vitest";
import { ObsidianVaultAdapter } from "../../src/vault/obsidian-adapter";
import { TEMP_SUFFIX } from "../../src/vault/paths";
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

describe("ObsidianVaultAdapter.removeTempFiles", () => {
	it("removes temp files anywhere on disk except the config directory", async () => {
		const vault = new FakeVault();
		vault.setFile("note.md", "keep");
		vault.setFile(`deep/a.md${TEMP_SUFFIX}`, "x");
		vault.setFile(`.github/ci.yml${TEMP_SUFFIX}`, "x");
		vault.setFile(`.obsidian/plugins/other/data.json${TEMP_SUFFIX}`, "theirs");

		await new ObsidianVaultAdapter(vault).removeTempFiles();

		expect([...vault.files.keys()].sort()).toEqual([".obsidian/plugins/other/data.json.univault-partial", "note.md"]);
	});
});

describe("ObsidianVaultAdapter.writeChunked", () => {
	it("cancels the stream when an append fails", async () => {
		const vault = new FakeVault();
		vault.adapter.appendBinary = async () => {
			throw new Error("disk error");
		};
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			pull: (controller) => controller.enqueue(enc("chunk")),
			cancel,
		});

		await expect(new ObsidianVaultAdapter(vault).writeChunked("note.md", stream, null)).rejects.toThrow("disk error");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("keeps an edit made while the download streamed and removes the temp file", async () => {
		const vault = new FakeVault();
		vault.setFile("note.md", "original");
		const adapter = new ObsidianVaultAdapter(vault);
		const expected = await adapter.stat("note.md");
		let sent = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) return controller.close();
				sent = true;
				vault.setFile("note.md", "typed meanwhile");
				controller.enqueue(enc("remote"));
			},
		});

		const error = await adapter.writeChunked("note.md", stream, expected).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "conflict-retry", paths: ["note.md"] });
		expect(new TextDecoder().decode(vault.bytes("note.md"))).toBe("typed meanwhile");
		expect([...vault.files.keys()]).toEqual(["note.md"]);
	});

	it("does not overwrite a file created while a new one streamed", async () => {
		const vault = new FakeVault();
		const adapter = new ObsidianVaultAdapter(vault);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				vault.setFile("new.md", "made locally");
				controller.enqueue(enc("remote"));
				controller.close();
			},
		});

		await expect(adapter.writeChunked("new.md", stream, null)).rejects.toMatchObject({ code: "conflict-retry" });
		expect(new TextDecoder().decode(vault.bytes("new.md"))).toBe("made locally");
	});

	it("appends each chunk to a temp file and moves it into a new folder", async () => {
		const vault = new FakeVault();
		const adapter = new ObsidianVaultAdapter(vault);

		await adapter.writeChunked("a/b/note.md", streamOf([enc("line 1\r\n"), enc("line 2\r\n")]), null);

		expect(new TextDecoder().decode(vault.bytes("a/b/note.md"))).toBe("line 1\r\nline 2\r\n");
		expect(vault.appendCalls).toEqual([`a/b/note.md${TEMP_SUFFIX}`, `a/b/note.md${TEMP_SUFFIX}`]);
		expect(vault.files.has(`a/b/note.md${TEMP_SUFFIX}`)).toBe(false);
	});

	it("replaces an existing file", async () => {
		const vault = new FakeVault();
		vault.setFile("note.md", "old");
		const adapter = new ObsidianVaultAdapter(vault);
		await adapter.writeChunked("note.md", streamOf([enc("new")]), await adapter.stat("note.md"));
		expect(new TextDecoder().decode(vault.bytes("note.md"))).toBe("new");
	});

	it("leaves the target untouched when the stream fails, and the temp file goes on cleanup", async () => {
		const vault = new FakeVault();
		vault.setFile("note.md", "original");
		const adapter = new ObsidianVaultAdapter(vault);

		await expect(adapter.writeChunked("note.md", streamOf([enc("par"), enc("tial")], 1), null)).rejects.toThrow(
			"network dropped",
		);
		expect(new TextDecoder().decode(vault.bytes("note.md"))).toBe("original");
		expect((await adapter.list()).map((f) => f.path)).toEqual(["note.md"]);

		await adapter.removeTempFiles();
		expect([...vault.files.keys()]).toEqual(["note.md"]);
	});
});
