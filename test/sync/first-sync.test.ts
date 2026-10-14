import { beforeEach, describe, expect, it } from "vitest";
import { outcomeMessage } from "../../src/ui/messages";
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
		expect(outcomeMessage(outcome)).toContain("a.md, c.md");
		expect(text(h.vault.bytes("a.md"))).toBe("local");
		expect(text(h.vault.bytes("c.md"))).toBe("local c");
		expect(h.github.head(REPO, "main")).toBe(head);
		expect(h.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
		expect(await h.store.getAnchor()).toBeNull();
	});

	it.each(["../escape.md", ".obsidian/plugins/univault/main.js"])(
		"refuses %s from the full tree with path-unsafe and writes nothing",
		async (unsafe) => {
			h.github.commitFiles(REPO, "main", { "fine.md": "fine", [unsafe]: "evil" });
			h.vault.setFile("local.md", "mine");

			const outcome = await h.orchestrator.sync("manual");

			expect(outcome.kind === "failed" && outcome.error.code).toBe("path-unsafe");
			expect([...h.vault.files.keys()]).toEqual(["local.md"]);
			expect(h.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
			expect(await h.store.getAnchor()).toBeNull();
		},
	);

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
		expect(h.github.requests.map((r) => r.status)).toEqual([304, 304]);
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

describe("empty repository bootstrap", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await createHarness();
	});

	it("creates the branch through the contents api, then commits the rest normally", async () => {
		h.vault.setFile("a.md", "first");
		h.vault.setFile("b.md", "second\r\n");
		h.vault.setFile("notes/c.md", "third");

		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 3, downloaded: 0 });

		const head = h.github.head(REPO, "main")!;
		const commit = h.github.commit(REPO, head)!;
		const root = h.github.commit(REPO, commit.parents[0]!)!;
		expect(root.parents).toEqual([]);
		expect(root.message.endsWith(TRAILER)).toBe(true);
		expect(commit.message.endsWith(TRAILER)).toBe(true);
		expect(h.github.requests.filter((r) => r.method === "PUT").map((r) => [r.path, r.status])).toEqual([
			[`/repos/${REPO}/contents/a.md`, 201],
		]);
		expect(text(h.github.file(REPO, "main", "a.md"))).toBe("first");
		expect(text(h.github.file(REPO, "main", "b.md"))).toBe("second\r\n");
		expect(text(h.github.file(REPO, "main", "notes/c.md"))).toBe("third");
		expect((await h.store.getAnchor())?.commitSha).toBe(head);
		expect([...(await h.store.getIndex()).keys()].sort()).toEqual(["a.md", "b.md", "notes/c.md"]);
	});

	it("makes one commit when the vault has a single file", async () => {
		h.vault.setFile("only.md", "solo");

		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 1, downloaded: 0 });
		const head = h.github.head(REPO, "main")!;
		expect(h.github.commit(REPO, head)?.parents).toEqual([]);
		expect((await h.store.getAnchor())?.commitSha).toBe(head);
	});

	it("finishes as a no-op when both the repository and the vault are empty", async () => {
		const outcome = await h.orchestrator.sync("manual");

		expect(outcome).toEqual({ kind: "remote-empty" });
		expect(outcomeMessage(outcome)).toContain("empty");
		expect(h.orchestrator.state).toBe("idle");
		expect(h.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
		expect(await h.store.getAnchor()).toBeNull();
	});

	it("fails not-found without bootstrapping when the branch is missing from a non-empty repository", async () => {
		const head = h.github.commitFiles(REPO, "main", { "a.md": "a" });
		h.settings = { ...h.settings, branch: "nope" };
		h.vault.setFile("b.md", "b");

		const outcome = await h.orchestrator.sync("manual");

		expect(outcome.kind === "failed" && outcome.error.code).toBe("not-found");
		expect(h.orchestrator.state).toBe("error");
		expect(h.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
		expect(h.github.head(REPO, "main")).toBe(head);
		expect(h.github.head(REPO, "nope")).toBeUndefined();
	});

	it("fails not-found without bootstrapping when the repository does not exist", async () => {
		h.settings = { ...h.settings, repository: "octo/missing" };
		h.vault.setFile("b.md", "b");

		const outcome = await h.orchestrator.sync("manual");

		expect(outcome.kind === "failed" && outcome.error.code).toBe("not-found");
		expect(h.github.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
	});

	it("does not bootstrap when the branch disappears after an anchor exists", async () => {
		await h.inSync({ "a.md": "a" });
		h.github.inject("GET", /git\/ref/, { status: 404 });
		h.vault.setFile("a.md", "changed");

		const outcome = await h.orchestrator.sync("manual");

		expect(outcome.kind === "failed" && outcome.error.code).toBe("not-found");
		expect(h.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
	});
});
