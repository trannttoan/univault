import type { App, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../manifest.json";
import UnivaultPlugin from "../src/main";
import { readSettings } from "../src/settings";
import { type PendingConflict, StateStore } from "../src/store/db";
import { FakeGitHub } from "./fakes/github";
import { App as FakeApp, type Plugin as FakePlugin, Modal, Notice } from "./fakes/obsidian";

const TOKEN = "github_pat_secret123";
const conflict = (fields: Partial<PendingConflict>): PendingConflict => ({
	path: "n.md",
	kind: "text-overlap",
	baseSha: "2".repeat(40),
	remoteSha: "3".repeat(40),
	remoteDevice: "Phone",
	remoteLogin: "octo",
	remoteTime: "2026-10-25T07:41:00Z",
	localSha: "1".repeat(40),
	localStat: { mtime: 1, size: 1 },
	localSnapshotId: null,
	choice: null,
	siblingPath: null,
	...fields,
});

describe("UnivaultPlugin", () => {
	let app: FakeApp;
	let plugin: UnivaultPlugin;
	let fake: FakePlugin;
	let github: FakeGitHub;

	beforeEach(async () => {
		Modal.opened.length = 0;
		github = new FakeGitHub();
		github.addToken(TOKEN, "octo");
		vi.stubGlobal("fetch", github.fetch);
		app = new FakeApp();
		plugin = new UnivaultPlugin(app as unknown as App, manifest as PluginManifest);
		fake = plugin as unknown as FakePlugin;
		await plugin.onload();
	});

	afterEach(() => {
		plugin.onunload();
		vi.unstubAllGlobals();
	});

	it("shows idle in the status bar and registers the commands and settings", () => {
		expect(fake.statusBarItems.map((el) => el.text)).toEqual(["Univault: idle"]);
		expect(fake.statusBarItems[0]?.listeners.has("click")).toBe(true);
		expect(fake.commands.map((command) => command.id)).toEqual(["sync-now", "resolve-conflicts"]);
		expect(fake.settingTabs).toHaveLength(1);
	});

	it("reports an unfinished setup through a notice and the status bar", async () => {
		expect(await plugin.syncNow()).toEqual({ kind: "needs-setup" });
		expect(Notice.shown.at(-1)).toContain("finish setup");
		expect(fake.statusBarItems[0]?.text).toBe("Univault: error");
	});

	it("syncs on a status bar click and shows exactly one notice, even when clicks coalesce", async () => {
		const click = fake.statusBarItems[0]?.listeners.get("click");
		expect(click).toBeDefined();
		const before = Notice.shown.length;
		click?.();
		await vi.waitFor(() => expect(Notice.shown.length).toBe(before + 1));

		const coalesced = Notice.shown.length;
		const first = plugin.syncNow();
		const second = plugin.syncNow();
		expect(await first).toEqual(await second);
		expect(Notice.shown.length).toBe(coalesced + 1);
	});

	it("adds a sync now ribbon icon for mobile that reports once", async () => {
		expect(fake.ribbonIcons.map(({ icon, title }) => [icon, title])).toEqual([["refresh-cw", "Sync now"]]);
		const before = Notice.shown.length;
		fake.ribbonIcons[0]?.callback();
		await vi.waitFor(() => expect(Notice.shown.length).toBe(before + 1));
	});

	it("defaults to branch main and the platform as device name", () => {
		expect(plugin.settings).toEqual({ repository: "", branch: "main", deviceName: "Mac" });
	});

	it("falls back to the platform device name when it is cleared", async () => {
		await plugin.updateSettings({ deviceName: "Laptop" });
		expect(plugin.settings.deviceName).toBe("Laptop");
		await plugin.updateSettings({ deviceName: "" });
		expect(plugin.settings.deviceName).toBe("Mac");
		expect(fake.data).toMatchObject({ deviceName: "Mac" });

		const defaults = { repository: "", branch: "main", deviceName: "Android" };
		expect(readSettings(defaults, { deviceName: "  ", extra: "dropped" })).toEqual(defaults);
	});

	it("keeps the token out of the settings object and the settings file", async () => {
		await plugin.session.signInWithToken(TOKEN);
		await plugin.updateSettings({ repository: "octo/vault" });

		expect(JSON.stringify(plugin.settings)).not.toContain(TOKEN);
		expect(JSON.stringify(fake.data)).not.toContain(TOKEN);
		expect(JSON.stringify([...app.localStorage.values()])).toContain(TOKEN);
	});

	it("saves settings one at a time, ending with the latest values", async () => {
		const order: string[] = [];
		const save = fake.saveData.bind(fake);
		vi.spyOn(fake, "saveData").mockImplementation(async (data) => {
			const { repository } = data as { repository: string };
			await new Promise((resolve) => setTimeout(resolve, repository === "o/a" ? 5 : 0));
			order.push(repository);
			await save(data);
		});

		void plugin.updateSettings({ repository: "o/a" });
		await plugin.updateSettings({ repository: "o/ab" });

		expect(order).toEqual(["o/ab", "o/ab"]);
		expect(fake.data).toMatchObject({ repository: "o/ab" });
	});

	it("shows a notice instead of rejecting when a save fails", async () => {
		vi.spyOn(fake, "saveData").mockRejectedValueOnce(new Error("disk full"));
		const before = Notice.shown.length;
		await expect(plugin.updateSettings({ deviceName: "Phone" })).resolves.toBeUndefined();
		expect(Notice.shown.slice(before)).toEqual(["Univault: couldn't save settings."]);
		await plugin.updateSettings({ deviceName: "Phone 2" });
		expect(fake.data).toMatchObject({ deviceName: "Phone 2" });
	});

	it("shows a merge notice whose review link opens the merged note", async () => {
		github.createRepo("octo/vault");
		github.commitFiles("octo/vault", "main", { "n.md": "one\n\ntwo\n" });
		await plugin.session.signInWithToken(TOKEN);
		await plugin.updateSettings({ repository: "octo/vault" });
		expect(await plugin.syncNow()).toMatchObject({ kind: "synced", downloaded: 1 });

		github.commitFiles("octo/vault", "main", { "n.md": "ONE\n\ntwo\n" });
		app.vault.setFile("n.md", "one\n\nTWO\n");
		expect(await plugin.syncNow()).toMatchObject({ kind: "synced", merged: ["n.md"] });

		const notice = Notice.instances.at(-1)!;
		expect(notice.message).toBe("Univault: synced, 0 uploaded, 0 downloaded, 1 merged.");
		const link = notice.messageEl.descendants().find((el) => el.tag === "a");
		expect(link?.text).toBe("Review n.md");
		link?.click();
		expect(app.workspace.opened).toEqual(["n.md"]);
	});

	it("opens a picker after a sync that leaves a conflict, and applies its dismissal as keep both", async () => {
		github.createRepo("octo/vault");
		github.commitFiles("octo/vault", "main", { "n.md": "line\n" });
		await plugin.session.signInWithToken(TOKEN);
		await plugin.updateSettings({ repository: "octo/vault" });
		await plugin.syncNow();

		github.commitFiles("octo/vault", "main", { "n.md": "line from A\n" }, "Sync from A\n\nUnivault-Device: octo/A");
		app.vault.setFile("n.md", "line from here\n");
		expect(await plugin.syncNow()).toMatchObject({ kind: "synced", conflicts: ["n.md"] });
		await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
		expect(Modal.opened[0]?.text()).toContain("n.md");

		Modal.opened[0]?.close();
		await vi.waitFor(() => expect([...app.vault.files.keys()].some((p) => p.startsWith("n (conflict from A "))).toBe(true));
		await vi.waitFor(async () => expect(await plugin.orchestrator.listConflicts()).toEqual([]));
		expect(new TextDecoder().decode(github.file("octo/vault", "main", "n.md"))).toBe("line from here\n");
		expect(Modal.opened).toHaveLength(0);
	});

	it("asks again after a restart about a conflict left unanswered, without syncing", async () => {
		const vaultId = plugin.session.vaultId();
		plugin.onunload();
		const ours = new TextEncoder().encode("ours, kept on disk\n");
		app.vault.setFile("n.md", ours);
		const store = await StateStore.open(vaultId);
		await store.putSnapshot({
			id: "snap",
			path: "n.md",
			bytes: ours,
			blobSha: "1".repeat(40),
			baseSha: "2".repeat(40),
			createdAt: new Date().toISOString(),
			reason: "conflict-local",
		});
		await store.putConflict(conflict({ localStat: { mtime: 1, size: ours.byteLength }, localSnapshotId: "snap" }));
		store.close();
		github.requests.length = 0;

		plugin = new UnivaultPlugin(app as unknown as App, manifest as PluginManifest);
		fake = plugin as unknown as FakePlugin;
		await plugin.onload();

		await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
		expect(Modal.opened[0]?.text()).toContain("Phone (octo)");
		expect(fake.statusBarItems[0]?.text).toBe("Univault: 1 conflict");
		expect(github.requests).toHaveLength(0);
		expect((await plugin.store.getSnapshot("snap"))?.bytes).toEqual(ours);
	});

	it("opens pickers from the resolve conflicts command, and none while one is open", async () => {
		const command = fake.commands.find((c) => c.id === "resolve-conflicts");
		await plugin.store.putConflict(conflict({ path: "a.md", kind: "binary", baseSha: null, remoteTime: "" }));
		command?.callback?.();
		command?.callback?.();
		await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(Modal.opened).toHaveLength(1);
	});

	it("discards the anchor at the next sync after the repository changes", async () => {
		github.createRepo("octo/other");
		const head = github.commitFiles("octo/other", "main", { "other.md": "o" });
		await plugin.session.signInWithToken(TOKEN);
		await plugin.store.advance({ repository: "octo/vault", branch: "main", commitSha: "c", treeSha: "t", refEtag: null }, []);
		await plugin.updateSettings({ repository: "octo/other" });
		expect((await plugin.store.getAnchor())?.repository).toBe("octo/vault");

		expect(await plugin.syncNow()).toEqual({ kind: "synced", uploaded: 0, downloaded: 1 });
		expect(await plugin.store.getAnchor()).toMatchObject({ repository: "octo/other", commitSha: head });
	});
});
