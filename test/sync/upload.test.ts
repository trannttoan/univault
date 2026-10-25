import { beforeEach, describe, expect, it } from "vitest";
import { gitBlobSha } from "../../src/vault/hash";
import { createHarness, type Harness, REPO, TRAILER } from "./harness";

describe("upload cycle", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await createHarness();
	});

	it("turns one modified note into exactly one commit on the anchor with the device trailer", async () => {
		const anchorSha = await h.inSync({ "a.md": "before", "b.md": "b" });
		h.vault.setFile("a.md", "after");

		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 1, downloaded: 0 });

		const head = h.github.head(REPO, "main")!;
		const commit = h.github.commit(REPO, head)!;
		expect(commit.parents).toEqual([anchorSha]);
		expect(commit.message).toBe(`Sync from Mac\n\n${TRAILER}`);
		expect(new TextDecoder().decode(h.github.file(REPO, "main", "a.md"))).toBe("after");
		expect(new TextDecoder().decode(h.github.file(REPO, "main", "b.md"))).toBe("b");
		expect(h.github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/git/commits"))).toHaveLength(1);

		const anchor = await h.store.getAnchor();
		expect(anchor).toMatchObject({ commitSha: head, treeSha: commit.tree });
		expect((await h.store.getIndex()).get("a.md")?.blobSha).toBe(await gitBlobSha(new TextEncoder().encode("after")));
	});

	it("uploads bytes exactly as read, including CRLF and every byte value", async () => {
		await h.inSync({ "keep.md": "k" });
		const crlf = new TextEncoder().encode("line one\r\nline two\r\n");
		const binary = new Uint8Array([...Array(256).keys()]);
		h.vault.setFile("crlf.md", crlf);
		h.vault.setFile("bytes.bin", binary);

		expect(await h.orchestrator.sync("manual")).toMatchObject({ kind: "synced", uploaded: 2 });
		expect(h.github.file(REPO, "main", "crlf.md")).toEqual(crlf);
		expect(h.github.file(REPO, "main", "bytes.bin")).toEqual(binary);
	});

	it("leaves anchor and index untouched when the ref update fails", async () => {
		await h.inSync({ "a.md": "before" });
		const anchor = await h.store.getAnchor();
		const index = await h.store.getIndex();
		h.vault.setFile("a.md", "after");
		h.github.inject("PATCH", /git\/refs/, { status: 500 });

		const outcome = await h.orchestrator.sync("manual");
		expect(outcome.kind === "failed" && outcome.error.code).toBe("unknown");
		expect(await h.store.getAnchor()).toEqual(anchor);
		expect(await h.store.getIndex()).toEqual(index);
	});

	it("re-runs once and commits on the new parent when another device pushes first", async () => {
		await h.inSync({ "a.md": "before" });
		h.vault.setFile("a.md", "after");
		let other: string | undefined;
		h.github.onRequest = (method) => {
			if (method === "PATCH" && !other) other = h.github.commitFiles(REPO, "main", {}, "other device");
		};

		expect(await h.orchestrator.sync("manual")).toMatchObject({ kind: "synced", uploaded: 1 });

		const head = h.github.head(REPO, "main")!;
		expect(h.github.commit(REPO, head)?.parents).toEqual([other]);
		expect(h.github.requests.filter((r) => r.method === "PATCH").map((r) => r.status)).toEqual([422, 200]);
		expect((await h.store.getAnchor())?.commitSha).toBe(head);
	});

	it("downloads the other device's change during the re-run and commits on top of it", async () => {
		await h.inSync({ "a.md": "before", "b.md": "b" });
		h.vault.setFile("a.md", "after");
		let other: string | undefined;
		h.github.onRequest = (method) => {
			if (method === "PATCH" && !other) other = h.github.commitFiles(REPO, "main", { "b.md": "b from phone" });
		};

		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 1, downloaded: 1 });
		expect(h.github.commit(REPO, h.github.head(REPO, "main")!)?.parents).toEqual([other]);
		expect(new TextDecoder().decode(h.vault.bytes("b.md"))).toBe("b from phone");
		expect(new TextDecoder().decode(h.github.file(REPO, "main", "a.md"))).toBe("after");
	});

	it("surfaces conflict-retry on the fourth rejection and leaves the anchor alone", async () => {
		await h.inSync({ "a.md": "before" });
		const anchor = await h.store.getAnchor();
		h.vault.setFile("a.md", "after");
		for (let i = 0; i < 4; i++) h.github.inject("PATCH", /git\/refs/, { status: 422 });

		const index = await h.store.getIndex();
		const outcome = await h.orchestrator.sync("manual");
		expect(outcome.kind === "failed" && outcome.error.code).toBe("conflict-retry");
		expect(h.github.requests.filter((r) => r.method === "PATCH")).toHaveLength(4);
		expect(await h.store.getAnchor()).toEqual(anchor);
		expect(await h.store.getIndex()).toEqual(index);
	});

	it("refuses an upload when GitHub's blob id differs from the local hash", async () => {
		const head = await h.inSync({ "a.md": "before" });
		h.vault.setFile("a.md", "after");
		h.github.inject("POST", /\/git\/blobs$/, { status: 201, body: { sha: "f".repeat(40) } });

		const outcome = await h.orchestrator.sync("manual");

		expect(outcome.kind === "failed" && outcome.error).toMatchObject({ code: "unknown", paths: ["a.md"] });
		expect(h.github.requests.filter((r) => r.path.endsWith("/git/commits") || r.method === "PATCH")).toHaveLength(0);
		expect(h.github.head(REPO, "main")).toBe(head);
	});

	it("refuses a file over the upload cap and names it", async () => {
		await h.inSync({ "a.md": "a" });
		h.vault.setFile("big.bin", new Uint8Array(2048));

		const outcome = await h.orchestrator.sync("manual");
		expect(outcome.kind === "failed" && outcome.error).toMatchObject({ code: "unknown", paths: ["big.bin"] });
		expect(h.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
	});

	it("holds back a note both sides changed in the same line and uploads the rest", async () => {
		await h.inSync({ "a.md": "base", "b.md": "b" });
		h.github.commitFiles(REPO, "main", { "a.md": "theirs" });
		h.vault.setFile("a.md", "ours");
		h.vault.setFile("b.md", "ours too");

		const outcome = await h.orchestrator.sync("manual");
		expect(outcome).toEqual({ kind: "synced", uploaded: 1, downloaded: 0, conflicts: ["a.md"] });
		expect(new TextDecoder().decode(h.vault.bytes("a.md"))).toBe("ours");
		expect(new TextDecoder().decode(h.github.file(REPO, "main", "a.md"))).toBe("theirs");
		expect(new TextDecoder().decode(h.github.file(REPO, "main", "b.md"))).toBe("ours too");
	});
});
