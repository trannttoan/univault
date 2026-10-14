import { beforeEach, describe, expect, it } from "vitest";
import { gitBlobSha } from "../../src/vault/hash";
import { createHarness, type Harness, REPO, TRAILER } from "./harness";

describe("download cycle", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await createHarness();
	});

	it("streams a remote change into the vault byte-identical, in several appends", async () => {
		await h.inSync({ "a.md": "a" });
		const crlf = new TextEncoder().encode("from the phone\r\nsecond line\r\n");
		const binary = new Uint8Array([...Array(256).keys()]);
		h.github.commitFiles(REPO, "main", { "a.md": crlf, "deep/er/bytes.bin": binary });

		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 2 });

		expect(h.vault.bytes("a.md")).toEqual(crlf);
		expect(h.vault.bytes("deep/er/bytes.bin")).toEqual(binary);
		expect(h.vault.appendCalls.filter((p) => p.startsWith("a.md")).length).toBeGreaterThan(1);
		expect([...h.vault.files.keys()].some((p) => p.endsWith(".univault-partial"))).toBe(false);
	});

	it("advances the anchor to the head and indexes the downloads", async () => {
		await h.inSync({ "a.md": "a" });
		const head = h.github.commitFiles(REPO, "main", { "b.md": "new" });

		await h.orchestrator.sync("manual");

		expect((await h.store.getAnchor())?.commitSha).toBe(head);
		const entry = (await h.store.getIndex()).get("b.md");
		expect(entry?.blobSha).toBe(await gitBlobSha(new TextEncoder().encode("new")));
		expect(entry?.size).toBe(3);

		h.github.requests.length = 0;
		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });
		expect(h.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
	});

	it("downloads a dot-prefixed file the vault index never lists", async () => {
		await h.inSync({ "a.md": "a" });
		const head = h.github.commitFiles(REPO, "main", { ".gitignore": "node_modules\n" });

		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 1 });
		expect(new TextDecoder().decode(h.vault.bytes(".gitignore"))).toBe("node_modules\n");
		expect((await h.store.getAnchor())?.commitSha).toBe(head);
		expect((await h.store.getIndex()).has(".gitignore")).toBe(true);
	});

	it.each(["../escape.md", ".obsidian/plugins/univault/main.js", ".OBSIDIAN/app.json"])(
		"refuses %s with path-unsafe and writes nothing",
		async (unsafe) => {
			await h.inSync({ "a.md": "a" });
			const anchor = await h.store.getAnchor();
			h.github.commitFiles(REPO, "main", { "fine.md": "fine", [unsafe]: "evil" });

			const outcome = await h.orchestrator.sync("manual");

			expect(outcome.kind === "failed" && outcome.error.code).toBe("path-unsafe");
			expect([...h.vault.files.keys()]).toEqual(["a.md"]);
			expect(h.vault.appendCalls).toHaveLength(0);
			expect(await h.store.getAnchor()).toEqual(anchor);
		},
	);

	it("uploads and downloads in one sync with one commit and indexes both", async () => {
		await h.inSync({ "mine.md": "v1", "theirs.md": "v1" });
		const remoteHead = h.github.commitFiles(REPO, "main", { "theirs.md": "v2 remote" });
		h.vault.setFile("mine.md", "v2 local");

		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 1, downloaded: 1 });

		const head = h.github.head(REPO, "main")!;
		const commit = h.github.commit(REPO, head)!;
		expect(commit.parents).toEqual([remoteHead]);
		expect(commit.message.endsWith(TRAILER)).toBe(true);
		expect(new TextDecoder().decode(h.github.file(REPO, "main", "mine.md"))).toBe("v2 local");
		expect(new TextDecoder().decode(h.github.file(REPO, "main", "theirs.md"))).toBe("v2 remote");
		expect(new TextDecoder().decode(h.vault.bytes("theirs.md"))).toBe("v2 remote");
		expect(h.github.requests.filter((r) => r.path.endsWith("/git/commits") && r.method === "POST")).toHaveLength(1);

		const index = await h.store.getIndex();
		expect([...index.keys()].sort()).toEqual(["mine.md", "theirs.md"]);
		expect((await h.store.getAnchor())?.commitSha).toBe(head);
	});

	it("falls back to the recursive tree when compare lists 300 files", async () => {
		await h.inSync({ "a.md": "a" });
		const files = Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`bulk/n${i}.md`, `note ${i}`]));
		h.github.commitFiles(REPO, "main", files);

		expect(await h.orchestrator.sync("manual")).toMatchObject({ kind: "synced", downloaded: 301 });
		expect(h.github.requests.some((r) => r.path.includes("/git/trees/"))).toBe(true);
		expect(new TextDecoder().decode(h.vault.bytes("bulk/n300.md"))).toBe("note 300");
	});
});
