import { beforeEach, describe, expect, it } from "vitest";
import { outcomeMessage } from "../../src/ui/messages";
import { gitBlobSha } from "../../src/vault/hash";
import { createHarness, type Harness, REPO } from "./harness";

const NOTE = "Daily note.md";
const BASE = "Morning.\n\nAfternoon.\n\nEvening.\n";
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const commitPosts = (h: Harness) => h.github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/git/commits"));

describe("two devices editing different paragraphs", () => {
	let a: Harness;
	let b: Harness;

	beforeEach(async () => {
		a = await createHarness();
		a.settings.deviceName = "A";
		await a.inSync({ [NOTE]: BASE, "other.md": "o" });
		b = await a.fork("B");
	});

	it("different paragraphs edited on A and B: both end with both edits and B's commit records the merge", async () => {
		a.vault.setFile(NOTE, "Morning, from A.\n\nAfternoon.\n\nEvening.\n");
		expect(await a.orchestrator.sync("manual")).toMatchObject({ kind: "synced", uploaded: 1 });
		const theirs = a.github.head(REPO, "main")!;

		b.vault.setFile(NOTE, "Morning.\n\nAfternoon.\n\nEvening, from B.\n");
		b.github.requests.length = 0;
		const outcome = await b.orchestrator.sync("manual");

		expect(outcome).toEqual({ kind: "synced", uploaded: 0, downloaded: 0, merged: [NOTE] });
		expect(outcomeMessage(outcome)).toContain("1 merged");
		expect(commitPosts(b)).toHaveLength(1);
		const head = b.github.head(REPO, "main")!;
		const commit = b.github.commit(REPO, head)!;
		expect(commit.parents).toEqual([theirs]);

		const trailers = commit.message.split("\n").filter((line) => line.startsWith("Univault-Merge: "));
		expect(trailers).toHaveLength(1);
		const tokens = trailers[0]!.slice("Univault-Merge: ".length).split(" ");
		const shas = tokens.slice(-3);
		expect(shas.every((sha) => /^[0-9a-f]{40}$/.test(sha))).toBe(true);
		expect(tokens.slice(0, -3).join(" ")).toBe(NOTE);
		const enc = new TextEncoder();
		expect(shas).toEqual([
			await gitBlobSha(enc.encode(BASE)),
			await gitBlobSha(enc.encode("Morning.\n\nAfternoon.\n\nEvening, from B.\n")),
			await gitBlobSha(enc.encode("Morning, from A.\n\nAfternoon.\n\nEvening.\n")),
		]);

		expect(await a.orchestrator.sync("manual")).toMatchObject({ kind: "synced", downloaded: 1 });
		const both = "Morning, from A.\n\nAfternoon.\n\nEvening, from B.\n";
		expect(text(a.vault.bytes(NOTE))).toBe(both);
		expect(b.vault.bytes(NOTE)).toEqual(a.vault.bytes(NOTE));
		expect(text(b.github.file(REPO, "main", NOTE))).toBe(both);

		b.github.requests.length = 0;
		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });
		expect(b.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
	});

	it("uploads B's other changes in the same commit as the merge", async () => {
		a.vault.setFile(NOTE, "Morning, from A.\n\nAfternoon.\n\nEvening.\n");
		await a.orchestrator.sync("manual");
		b.vault.setFile(NOTE, "Morning.\n\nAfternoon.\n\nEvening, from B.\n");
		b.vault.setFile("other.md", "o from B");
		b.github.requests.length = 0;

		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 1, downloaded: 0, merged: [NOTE] });
		expect(commitPosts(b)).toHaveLength(1);
		expect(text(b.github.file(REPO, "main", "other.md"))).toBe("o from B");
	});

	it("treats a merge that adds nothing to theirs as a download, with no commit", async () => {
		a.vault.setFile(NOTE, "Morning, edited.\n\nAfternoon.\n\nEvening, edited.\n");
		await a.orchestrator.sync("manual");
		b.vault.setFile(NOTE, "Morning, edited.\n\nAfternoon.\n\nEvening.\n");
		b.github.requests.length = 0;

		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 1 });
		expect(commitPosts(b)).toHaveLength(0);
		expect(text(b.vault.bytes(NOTE))).toBe("Morning, edited.\n\nAfternoon.\n\nEvening, edited.\n");
		expect((await b.store.getAnchor())?.commitSha).toBe(a.github.head(REPO, "main"));
	});

	it("does not write the merge over a note edited after the scan", async () => {
		a.vault.setFile(NOTE, "Morning, from A.\n\nAfternoon.\n\nEvening.\n");
		await a.orchestrator.sync("manual");
		b.vault.setFile(NOTE, "Morning.\n\nAfternoon.\n\nEvening, from B.\n");
		let typed = false;
		b.github.onRequest = (method, path) => {
			if (!typed && method === "GET" && path.includes("/git/blobs/")) {
				typed = true;
				b.vault.setFile(NOTE, "Morning.\n\nAfternoon.\n\nEvening, from B, still typing.\n");
			}
		};

		const outcome = await b.orchestrator.sync("manual");
		expect(outcome.kind === "failed" && outcome.error).toMatchObject({ code: "conflict-retry", paths: [NOTE] });
		expect(text(b.vault.bytes(NOTE))).toBe("Morning.\n\nAfternoon.\n\nEvening, from B, still typing.\n");

		b.github.onRequest = null;
		expect(await b.orchestrator.sync("manual")).toMatchObject({ kind: "synced", merged: [NOTE] });
		expect(text(b.vault.bytes(NOTE))).toBe("Morning, from A.\n\nAfternoon.\n\nEvening, from B, still typing.\n");
	});
});
