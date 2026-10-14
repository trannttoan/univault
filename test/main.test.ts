import type { App, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../manifest.json";
import UnivaultPlugin from "../src/main";
import { FakeGitHub } from "./fakes/github";
import { App as FakeApp, type Plugin as FakePlugin } from "./fakes/obsidian";

const TOKEN = "github_pat_secret123";

describe("UnivaultPlugin", () => {
	let app: FakeApp;
	let plugin: UnivaultPlugin;
	let fake: FakePlugin;

	beforeEach(async () => {
		const github = new FakeGitHub();
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
		expect(fake.commands.map((command) => command.id)).toEqual(["sync-now"]);
		expect(fake.settingTabs).toHaveLength(1);
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

	it("discards the anchor when the repository or branch changes", async () => {
		const anchor = { repository: "octo/vault", branch: "main", commitSha: "c", treeSha: "t", refEtag: null };
		await plugin.store?.advance(anchor, []);
		await plugin.updateSettings({ deviceName: "Laptop" });
		expect(await plugin.store?.getAnchor()).toEqual(anchor);

		await plugin.updateSettings({ branch: "notes" });
		expect(await plugin.store?.getAnchor()).toBeNull();
	});
});
