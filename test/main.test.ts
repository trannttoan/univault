import type { App, PluginManifest } from "obsidian";
import { expect, it } from "vitest";
import manifest from "../manifest.json";
import UnivaultPlugin from "../src/main";
import { App as FakeApp, type Plugin as FakePlugin } from "./fakes/obsidian";

it("shows idle in the status bar and registers the sync command", () => {
	const plugin = new UnivaultPlugin(new FakeApp() as App, manifest as PluginManifest);
	plugin.onload();

	const fake = plugin as unknown as FakePlugin;
	expect(fake.statusBarItems.map((el) => el.text)).toEqual(["Univault: idle"]);
	expect(fake.commands.map((command) => command.id)).toEqual(["sync-now"]);
});
