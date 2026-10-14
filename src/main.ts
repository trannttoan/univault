import { Platform, Plugin } from "obsidian";
import { SessionStore } from "./session";
import { UnivaultSettingTab, type UnivaultSettings, defaultSettings, readSettings } from "./settings";
import { StateStore } from "./store/db";

export default class UnivaultPlugin extends Plugin {
	settings!: UnivaultSettings;
	session!: SessionStore;
	store: StateStore | null = null;

	async onload(): Promise<void> {
		this.settings = readSettings(defaultSettings(Platform), await this.loadData());
		this.session = new SessionStore(this.app, (input, init) => fetch(input, init));
		this.store = await StateStore.open(this.session.vaultId());

		this.addStatusBarItem().setText("Univault: idle");
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {},
		});
		this.addSettingTab(new UnivaultSettingTab(this.app, this));
	}

	onunload(): void {
		this.store?.close();
	}

	async updateSettings(change: Partial<UnivaultSettings>): Promise<void> {
		const next = { ...this.settings, ...change };
		const moved = next.repository !== this.settings.repository || next.branch !== this.settings.branch;
		this.settings = next;
		await this.saveData(this.settings);
		if (moved) await this.store?.discardAnchor();
	}
}
