import type { App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickConflict, pickInTurn } from "../../src/ui/conflict-picker";
import { gitBlobSha } from "../../src/vault/hash";
import { App as FakeApp, Modal } from "../fakes/obsidian";
import { createHarness, type Harness, REPO } from "./harness";

const NOTE = "Daily note.md";
const BASE = "Morning, first line.\nMorning, second line.\n\nEvening.\n";
const THEIRS = "Morning, first line from A.\nMorning, second line.\n\nEvening.\n";
const OURS = "Morning, first line.\nMorning, second line from B.\n\nEvening.\n";
const A_TIME = "2026-10-25T07:41:00Z";
const SIBLING = "Daily note (conflict from A 2026-10-25 14.03).md";
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe("same paragraph edited on two devices", () => {
	let a: Harness;
	let b: Harness;

	beforeEach(async () => {
		Modal.open.length = 0;
		a = await createHarness();
		a.settings.deviceName = "A";
		await a.inSync({ [NOTE]: BASE, "other.md": "o" });
		b = await a.fork("B");
		b.now = () => new Date(2026, 9, 25, 14, 3);

		a.vault.setFile(NOTE, THEIRS);
		a.github.now = () => new Date(A_TIME);
		await a.orchestrator.sync("manual");
		b.vault.setFile(NOTE, OURS);
		b.vault.setFile("other.md", "o from B");
	});

	it("same paragraph edited on A and B: B keeps its note, syncs the rest and records one conflict", async () => {
		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 1, downloaded: 0, conflicts: [NOTE] });

		expect(text(b.vault.bytes(NOTE))).toBe(OURS);
		expect(text(b.github.file(REPO, "main", "other.md"))).toBe("o from B");
		expect(text(b.github.file(REPO, "main", NOTE))).toBe(THEIRS);
		const records = await b.orchestrator.conflicts();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ path: NOTE, kind: "text-overlap", remoteDevice: "A", remoteTime: A_TIME, choice: null });
		expect(text((await b.store.getSnapshot(records[0]!.localSnapshotId!))?.bytes)).toBe(OURS);
		expect((await b.store.getIndex()).get(NOTE)?.blobSha).toBe(records[0]?.baseSha);
	});

	it("keeps one snapshot of B's version however often the push is rejected or the sync fails", async () => {
		const rejected = { status: 422, body: { message: "Update is not a fast forward" } };
		for (let attempt = 0; attempt < 4 * 2 + 2; attempt++) b.github.inject("PATCH", /git\/refs/, rejected);
		expect(await b.orchestrator.sync("manual")).toMatchObject({ kind: "failed" });
		expect(await b.orchestrator.sync("manual")).toMatchObject({ kind: "failed" });
		expect(await b.orchestrator.sync("manual")).toMatchObject({ kind: "synced", conflicts: [NOTE] });

		const snapshots = await b.store.getSnapshots();
		expect(snapshots.map((s) => [s.reason, text(s.bytes)])).toEqual([["conflict-local", OURS]]);
		expect((await b.orchestrator.conflicts())[0]?.localSnapshotId).toBe(snapshots[0]?.id);
	});

	it("shows one picker naming the file, the other device and the time; dismissing it keeps both on both devices", async () => {
		await b.orchestrator.sync("manual");
		const [record] = await b.orchestrator.conflicts();
		const app = new FakeApp();
		const choice = pickConflict(app as unknown as App, record!);

		expect(Modal.open).toHaveLength(1);
		const shown = Modal.open[0]!.text();
		expect(shown).toContain(NOTE);
		expect(shown).toContain("A");
		expect(shown).toContain(new Date(A_TIME).toLocaleString());

		Modal.open[0]!.close();
		expect(await choice).toBe("both");
		await b.orchestrator.resolve(NOTE, "both");

		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 2, downloaded: 0 });
		expect(await a.orchestrator.sync("manual")).toMatchObject({ kind: "synced", downloaded: 3 });
		for (const device of [a, b]) {
			expect(text(device.vault.bytes(NOTE))).toBe(OURS);
			expect(text(device.vault.bytes(SIBLING))).toBe(THEIRS);
		}
		expect(await b.orchestrator.conflicts()).toEqual([]);

		b.github.requests.length = 0;
		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });
		expect(b.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
	});

	it("keeps both by writing the sibling once when the push after it fails", async () => {
		await b.orchestrator.sync("manual");
		await b.orchestrator.resolve(NOTE, "both");
		b.github.inject("PATCH", /git\/refs/, "network");
		expect((await b.orchestrator.sync("manual")).kind).toBe("failed");
		expect(text(b.vault.bytes(SIBLING))).toBe(THEIRS);

		b.now = () => new Date(2026, 9, 25, 14, 9);
		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 2, downloaded: 0 });
		expect([...b.vault.files.keys()].filter((p) => p.includes("conflict from"))).toEqual([SIBLING]);
	});

	it("numbers the sibling when one from the same minute exists", async () => {
		await b.orchestrator.sync("manual");
		b.vault.setFile(SIBLING, "an older copy");
		await b.orchestrator.resolve(NOTE, "both");

		await b.orchestrator.sync("manual");
		expect(text(b.vault.bytes(SIBLING))).toBe("an older copy");
		expect(text(b.vault.bytes("Daily note (conflict from A 2026-10-25 14.03 2).md"))).toBe(THEIRS);
	});

	it("keep mine: both devices end with B's version, from one commit by B", async () => {
		await b.orchestrator.sync("manual");
		await b.orchestrator.resolve(NOTE, "mine");
		b.github.requests.length = 0;

		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 1, downloaded: 0 });
		expect(b.github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/git/commits"))).toHaveLength(1);
		await a.orchestrator.sync("manual");
		for (const device of [a, b]) expect(text(device.vault.bytes(NOTE))).toBe(OURS);
		expect(await b.orchestrator.conflicts()).toEqual([]);
		expect([...b.vault.files.keys()].some((p) => p.includes("conflict from"))).toBe(false);
	});

	it("keep theirs: both devices end with A's version and B commits nothing for it", async () => {
		await b.orchestrator.sync("manual");
		await b.orchestrator.resolve(NOTE, "theirs");
		b.github.requests.length = 0;

		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });
		expect(b.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
		await a.orchestrator.sync("manual");
		for (const device of [a, b]) expect(text(device.vault.bytes(NOTE))).toBe(THEIRS);
		expect(await b.orchestrator.conflicts()).toEqual([]);

		b.github.requests.length = 0;
		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });
		expect(b.github.requests.map((r) => r.status)).toEqual([304]);
	});

	it("keep theirs after the note was edited again asks again instead of overwriting the edit", async () => {
		await b.orchestrator.sync("manual");
		await b.orchestrator.resolve(NOTE, "theirs");
		const edited = `${OURS}\nOne more thought.\n`;
		b.vault.setFile(NOTE, edited);

		expect(await b.orchestrator.sync("manual")).toMatchObject({ kind: "synced", conflicts: [NOTE] });
		expect(text(b.vault.bytes(NOTE))).toBe(edited);
		const [record] = await b.orchestrator.conflicts();
		expect(record).toMatchObject({ choice: null, localSha: await gitBlobSha(new TextEncoder().encode(edited)) });
		expect(text((await b.store.getSnapshot(record!.localSnapshotId!))?.bytes)).toBe(edited);

		const choice = pickConflict(new FakeApp() as unknown as App, record!);
		Modal.open[0]!.button("Keep theirs")!.click();
		await b.orchestrator.resolve(NOTE, await choice);
		await b.orchestrator.sync("manual");
		expect(text(b.vault.bytes(NOTE))).toBe(THEIRS);
		expect(await b.orchestrator.conflicts()).toEqual([]);
	});

	it("keep theirs still applies when the note was only touched, not edited", async () => {
		await b.orchestrator.sync("manual");
		await b.orchestrator.resolve(NOTE, "theirs");
		b.vault.setFile(NOTE, OURS);

		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });
		expect(text(b.vault.bytes(NOTE))).toBe(THEIRS);
		expect(await b.orchestrator.conflicts()).toEqual([]);
	});

	it("offers keep mine, keep theirs and keep both, and records the one clicked", async () => {
		await b.orchestrator.sync("manual");
		const [record] = await b.orchestrator.conflicts();
		const app = new FakeApp() as unknown as App;
		for (const [label, expected] of [["Keep mine", "mine"], ["Keep theirs", "theirs"], ["Keep both", "both"]] as const) {
			const choice = pickConflict(app, record!);
			Modal.open[0]?.button(label)?.click();
			expect(await choice).toBe(expected);
			expect(Modal.open).toHaveLength(0);
		}
	});

	it("refreshes the record when A edits the note again while it is pending, dropping an old answer", async () => {
		await b.orchestrator.sync("manual");
		await b.orchestrator.resolve(NOTE, "theirs");
		const again = "Morning, first line from A, edited again.\nMorning, second line.\n\nEvening.\n";
		a.vault.setFile(NOTE, again);
		await a.orchestrator.sync("manual");

		expect(await b.orchestrator.sync("manual")).toMatchObject({ kind: "synced", conflicts: [NOTE] });
		const records = await b.orchestrator.conflicts();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ remoteSha: await gitBlobSha(new TextEncoder().encode(again)), choice: null });
		expect(text(b.vault.bytes(NOTE))).toBe(OURS);
	});

	it("does not upload a local edit to a pending note", async () => {
		await b.orchestrator.sync("manual");
		b.vault.setFile(NOTE, `${OURS}more\n`);
		b.github.requests.length = 0;

		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 0, conflicts: [NOTE] });
		expect(b.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
		expect(text(b.github.file(REPO, "main", NOTE))).toBe(THEIRS);
		expect(b.orchestrator.state).toBe("conflicts-pending");
		expect(b.orchestrator.pendingConflicts).toBe(1);
	});

	it("opens one picker per conflict, in path order, each after the previous is answered", async () => {
		a.vault.setFile("other.md", "o from A");
		await a.orchestrator.sync("manual");
		expect(await b.orchestrator.sync("manual")).toMatchObject({ conflicts: [NOTE, "other.md"] });

		let answered = 0;
		const app = new FakeApp() as unknown as App;
		const done = pickInTurn(app, b.orchestrator, () => answered++);
		await vi.waitFor(() => expect(Modal.open).toHaveLength(1));
		expect(Modal.open[0]?.text()).toContain(NOTE);
		Modal.open[0]?.button("Keep mine")?.click();

		await vi.waitFor(() => expect(Modal.open[0]?.text()).toContain("other.md"));
		expect(Modal.open).toHaveLength(1);
		Modal.open[0]?.close();
		await done;

		expect(answered).toBe(2);
		expect((await b.orchestrator.conflicts()).map((c) => [c.path, c.choice])).toEqual([
			[NOTE, "mine"],
			["other.md", "both"],
		]);
	});
});

describe("two-sided changes that are never merged", () => {
	let a: Harness;
	let b: Harness;
	const blobReads = (h: Harness) => h.github.requests.filter((r) => r.method === "GET" && r.path.includes("/git/blobs/"));

	beforeEach(async () => {
		Modal.open.length = 0;
		a = await createHarness();
		a.settings.deviceName = "A";
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
		await a.inSync({ "pic.png": png, "nul.md": "a\0\n", "big.md": "x".repeat(40), "big.png": "x".repeat(40), "plain.md": "p" });
		b = await a.fork("B");
		b.now = () => new Date(2026, 9, 25, 14, 3);
	});

	it.each([
		["pic.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2]), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 3]), "binary"],
		["nul.md", "a\0\nfrom A\n", "a\0\nfrom B\n", "binary"],
		["big.md", `${"x".repeat(40)}\n\nfrom A`, `from B\n\n${"x".repeat(40)}`, "text-overlap"],
		["big.png", `${"x".repeat(40)}A`, `${"x".repeat(40)}B`, "binary"],
	] as const)("%s changed on both sides opens a picker without reading a blob", async (path, theirs, ours, kind) => {
		b.mergeCapBytes = 32;
		a.vault.setFile(path, theirs);
		await a.orchestrator.sync("manual");
		b.vault.setFile(path, ours);
		b.github.requests.length = 0;

		expect(await b.orchestrator.sync("manual")).toMatchObject({ kind: "synced", conflicts: [path] });
		expect(blobReads(b)).toEqual([]);
		const [record] = await b.orchestrator.conflicts();
		expect(record).toMatchObject({ path, kind });
		expect(record?.localSnapshotId === null).toBe(path.startsWith("big."));

		const app = new FakeApp() as unknown as App;
		void pickConflict(app, record!);
		expect(Modal.open[0]?.text()).toContain(path);
	});

	it("does not merge when theirs is over the cap, and stops reading it there", async () => {
		b.mergeCapBytes = 48;
		a.vault.setFile("big.md", `${"x".repeat(40)}\n\n${"y".repeat(40)}`);
		await a.orchestrator.sync("manual");
		b.vault.setFile("big.md", `from B\n\n${"x".repeat(40)}`);

		expect(await b.orchestrator.sync("manual")).toMatchObject({ kind: "synced", conflicts: ["big.md"] });
		expect((await b.orchestrator.conflicts())[0]).toMatchObject({ kind: "text-overlap" });
		expect(text(b.vault.bytes("big.md"))).toBe(`from B\n\n${"x".repeat(40)}`);
	});

	describe("a daily note created on both devices", () => {
		const DAILY = "2026-10-25.md";

		beforeEach(async () => {
			a.vault.setFile(DAILY, "# Today\n\nFrom A.\n");
			await a.orchestrator.sync("manual");
			b.vault.setFile(DAILY, "# Today\n\nFrom B.\n");
			expect(await b.orchestrator.sync("manual")).toMatchObject({ kind: "synced", conflicts: [DAILY] });
			expect((await b.orchestrator.conflicts())[0]).toMatchObject({ path: DAILY, baseSha: null, kind: "text-overlap" });
		});

		const converge = async () => {
			await b.orchestrator.sync("manual");
			await a.orchestrator.sync("manual");
			expect(await b.orchestrator.conflicts()).toEqual([]);
			expect(a.vault.bytes(DAILY)).toEqual(b.vault.bytes(DAILY));
		};

		it("keep mine", async () => {
			await b.orchestrator.resolve(DAILY, "mine");
			await converge();
			expect(text(a.vault.bytes(DAILY))).toBe("# Today\n\nFrom B.\n");
		});

		it("keep theirs", async () => {
			await b.orchestrator.resolve(DAILY, "theirs");
			await converge();
			expect(text(a.vault.bytes(DAILY))).toBe("# Today\n\nFrom A.\n");
		});

		it("keep both", async () => {
			await b.orchestrator.resolve(DAILY, "both");
			await converge();
			expect(text(a.vault.bytes(DAILY))).toBe("# Today\n\nFrom B.\n");
			expect(text(a.vault.bytes("2026-10-25 (conflict from A 2026-10-25 14.03).md"))).toBe("# Today\n\nFrom A.\n");
		});
	});

	it("keeps identical content created on both devices a silent noop", async () => {
		a.vault.setFile("same.md", "same");
		await a.orchestrator.sync("manual");
		b.vault.setFile("same.md", "same");
		b.github.requests.length = 0;

		expect(await b.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });
		expect(b.github.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
		expect(await b.orchestrator.conflicts()).toEqual([]);
	});
});
