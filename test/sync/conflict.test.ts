import type { App } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { pickConflict } from "../../src/ui/conflict-picker";
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

		const app = new FakeApp();
		void pickConflict(app as unknown as App, record!);
		expect(Modal.open[0]?.button("Keep theirs")).toBeDefined();
		Modal.open[0]?.button("Keep theirs")?.click();
		await b.orchestrator.resolve(NOTE, "theirs");
		await b.orchestrator.sync("manual");
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
});
