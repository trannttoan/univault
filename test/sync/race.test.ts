import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, REPO } from "./harness";

const NOTE = "Shared note.md";
const BASE = "First paragraph.\nIts second line.\n\nLast paragraph.\n";
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const patches = (h: Harness) => h.github.requests.filter((r) => r.method === "PATCH").map((r) => r.status);

describe("two devices pushing within the same second", () => {
	let a: Harness;
	let b: Harness;

	beforeEach(async () => {
		a = await createHarness();
		a.settings.deviceName = "A";
		await a.inSync({ [NOTE]: BASE, "a.md": "a", "b.md": "b" });
		b = await a.fork("B");
	});

	// A runs a whole sync after B has made its commit and before B moves the ref.
	const raceOnce = () => {
		let raced = false;
		b.github.onRequest = async (method) => {
			if (raced || method !== "PATCH") return;
			raced = true;
			expect(await a.orchestrator.sync("manual")).toMatchObject({ kind: "synced", uploaded: 1 });
		};
	};

	// Every file B changed before its sync is still on disk or kept in a snapshot.
	const kept = async (before: Map<string, Uint8Array>) => {
		const snapshots = (await b.store.getSnapshots()).map((s) => text(s.bytes));
		for (const [path, bytes] of before) {
			expect(text(b.vault.bytes(path)) === text(bytes) || snapshots.includes(text(bytes))).toBe(true);
		}
	};
	const holding = (...paths: string[]) => new Map(paths.map((path) => [path, b.vault.bytes(path)!.slice()]));

	it("different files: B retries on top of A's push and both end with both changes", async () => {
		a.vault.setFile("a.md", "a from A");
		b.vault.setFile("b.md", "b from B");
		const before = holding("b.md");
		raceOnce();

		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 1, downloaded: 1 });
		expect(patches(b)).toEqual([200, 422, 200]);
		b.github.onRequest = null;
		await a.orchestrator.sync("manual");
		for (const device of [a, b]) {
			expect(text(device.vault.bytes("a.md"))).toBe("a from A");
			expect(text(device.vault.bytes("b.md"))).toBe("b from B");
		}
		await kept(before);
	});

	it("same file, different paragraphs: B merges on the retry and both vaults are byte-equal", async () => {
		a.vault.setFile(NOTE, "First paragraph, from A.\nIts second line.\n\nLast paragraph.\n");
		b.vault.setFile(NOTE, "First paragraph.\nIts second line.\n\nLast paragraph, from B.\n");
		const before = holding(NOTE);
		raceOnce();

		expect(await b.orchestrator.sync("manual")).toMatchObject({ kind: "synced", merged: [NOTE] });
		b.github.onRequest = null;
		await a.orchestrator.sync("manual");
		expect(text(a.vault.bytes(NOTE))).toBe("First paragraph, from A.\nIts second line.\n\nLast paragraph, from B.\n");
		expect(b.vault.bytes(NOTE)).toEqual(a.vault.bytes(NOTE));
		expect(text(b.github.file(REPO, "main", NOTE))).toBe(text(a.vault.bytes(NOTE)));
		await kept(before);
	});

	it("same paragraph: B's retry leaves a pending conflict with B's bytes still on disk", async () => {
		a.vault.setFile(NOTE, "First paragraph, from A.\nIts second line.\n\nLast paragraph.\n");
		const ours = "First paragraph.\nIts second line, from B.\n\nLast paragraph.\n";
		b.vault.setFile(NOTE, ours);
		b.vault.setFile("b.md", "b from B");
		const before = holding(NOTE, "b.md");
		raceOnce();

		expect(await b.orchestrator.sync("manual")).toMatchObject({ kind: "synced", uploaded: 1, conflicts: [NOTE] });
		expect(text(b.vault.bytes(NOTE))).toBe(ours);
		expect(text(b.github.file(REPO, "main", "b.md"))).toBe("b from B");
		expect(await b.orchestrator.conflicts()).toMatchObject([{ path: NOTE, remoteDevice: "A" }]);
		await kept(before);
	});

	it("a merge already written survives a second rejection, and the retry does not duplicate an append", async () => {
		a.vault.setFile(NOTE, `${BASE}\nAppended by A.\n`);
		await a.orchestrator.sync("manual");
		b.vault.setFile(NOTE, "First paragraph, from B.\nIts second line.\n\nLast paragraph.\n");
		const before = holding(NOTE);
		let raced = false;
		b.github.onRequest = async (method) => {
			if (raced || method !== "PATCH") return;
			raced = true;
			a.vault.setFile(NOTE, `${BASE}\nAppended by A.\n\nAppended again.\n`);
			await a.orchestrator.sync("manual");
		};

		expect(await b.orchestrator.sync("manual")).toMatchObject({ kind: "synced", merged: [NOTE] });
		expect(text(b.vault.bytes(NOTE))).toBe(
			"First paragraph, from B.\nIts second line.\n\nLast paragraph.\n\nAppended by A.\n\nAppended again.\n",
		);
		expect(await b.store.getSnapshots()).toHaveLength(1);
		await kept(before);
	});

	it("four rejections in a row end in conflict-retry with nothing pushed", async () => {
		b.vault.setFile("b.md", "b from B");
		const head = b.github.head(REPO, "main");
		const anchor = await b.store.getAnchor();
		for (let i = 0; i < 4; i++) b.github.inject("PATCH", /git\/refs/, { status: 422 });

		const outcome = await b.orchestrator.sync("manual");
		expect(outcome.kind === "failed" && outcome.error.code).toBe("conflict-retry");
		expect(patches(b)).toEqual([422, 422, 422, 422]);
		expect(b.github.head(REPO, "main")).toBe(head);
		expect(await b.store.getAnchor()).toEqual(anchor);
		expect(text(b.vault.bytes("b.md"))).toBe("b from B");
	});
});
