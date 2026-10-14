import type { App, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../manifest.json";
import UnivaultPlugin from "../src/main";
import { FakeGitHub } from "./fakes/github";
import { App as FakeApp, type Plugin as FakePlugin, Notice } from "./fakes/obsidian";

const TOKEN = "github_pat_secret123";

describe("UnivaultPlugin", () => {
	let app: FakeApp;
	let plugin: UnivaultPlugin;
	let fake: FakePlugin;
	let github: FakeGitHub;

	beforeEach(async () => {
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

	it("shows idle in the status bar and registers the sync command and settings", () => {
		expect(fake.statusBarItems.map((el) => el.text)).toEqual(["Univault: idle"]);
		expect(fake.statusBarItems[0].listeners.has("click")).toBe(true);
		expect(fake.commands.map((command) => command.id)).toEqual(["sync-now"]);
		expect(fake.settingTabs).toHaveLength(1);
	});

	it("reports an unfinished setup through a notice and the status bar", async () => {
		expect(await plugin.syncNow()).toEqual({ kind: "needs-setup" });
		expect(Notice.shown.at(-1)).toContain("finish setup");
		expect(fake.statusBarItems[0].text).toBe("Univault: error");
	});

	it("defaults to branch main and the platform as device name", () => {
		expect(plugin.settings).toEqual({ repository: "", branch: "main", deviceName: "Mac" });
	});

	it("keeps the token out of the settings object and the settings file", async () => {
		await plugin.session.signInWithToken(TOKEN);
		await plugin.updateSettings({ repository: "octo/vault" });

		expect(JSON.stringify(plugin.settings)).not.toContain(TOKEN);
		expect(JSON.stringify(fake.data)).not.toContain(TOKEN);
		expect(JSON.stringify([...app.localStorage.values()])).toContain(TOKEN);
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
