import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, REPO, TRAILER } from "./harness";

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe("first sync without an anchor", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await createHarness();
	});

	it("indexes identical content on both sides without any write", async () => {
		const head = h.github.commitFiles(REPO, "main", { "a.md": "same", "n/b.md": "same too" });
		h.vault.setFile("a.md", "same");
		h.vault.setFile("n/b.md", "same too");

		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });

		expect(h.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
		expect(h.vault.appendCalls).toHaveLength(0);
		expect((await h.store.getAnchor())?.commitSha).toBe(head);
		expect([...(await h.store.getIndex()).keys()].sort()).toEqual(["a.md", "n/b.md"]);
	});

	it("refuses before writing anything when a shared path differs, naming exactly those paths", async () => {
		const head = h.github.commitFiles(REPO, "main", { "a.md": "remote", "b.md": "same", "c.md": "remote c" });
		h.vault.setFile("a.md", "local");
		h.vault.setFile("b.md", "same");
		h.vault.setFile("c.md", "local c");
		h.vault.setFile("only-local.md", "mine");

		const outcome = await h.orchestrator.sync("manual");

		expect(outcome.kind === "failed" && outcome.error).toMatchObject({ code: "conflict-retry", paths: ["a.md", "c.md"] });
		expect(text(h.vault.bytes("a.md"))).toBe("local");
		expect(text(h.vault.bytes("c.md"))).toBe("local c");
		expect(h.github.head(REPO, "main")).toBe(head);
		expect(h.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
		expect(await h.store.getAnchor()).toBeNull();
	});

	it("uploads local-only paths and downloads remote-only paths in one sync", async () => {
		const remoteHead = h.github.commitFiles(REPO, "main", { "remote.md": "from repo" });
		h.vault.setFile("local.md", "from vault");

		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 1, downloaded: 1 });

		const head = h.github.head(REPO, "main")!;
		expect(h.github.commit(REPO, head)).toMatchObject({ parents: [remoteHead] });
		expect(h.github.commit(REPO, head)?.message.endsWith(TRAILER)).toBe(true);
		expect(text(h.vault.bytes("remote.md"))).toBe("from repo");
		expect(text(h.github.file(REPO, "main", "local.md"))).toBe("from vault");
		expect([...(await h.store.getIndex()).keys()].sort()).toEqual(["local.md", "remote.md"]);

		h.github.requests.length = 0;
		await h.orchestrator.sync("manual");
		await h.orchestrator.sync("manual");
		expect(h.github.requests.map((r) => r.status)).toEqual([200, 304]);
	});

	it("starts over after the repository changes in settings", async () => {
		await h.inSync({ "a.md": "a" });
		h.github.createRepo("octo/other");
		h.github.commitFiles("octo/other", "main", { "other.md": "o" });
		h.settings = { ...h.settings, repository: "octo/other" };

		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 1, downloaded: 1 });
		expect((await h.store.getAnchor())?.repository).toBe("octo/other");
	});
});
