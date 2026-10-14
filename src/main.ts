import { Notice, Platform, Plugin } from "obsidian";
import { SessionStore } from "./session";
import { UnivaultSettingTab, type UnivaultSettings, defaultSettings, readSettings } from "./settings";
import { StateStore } from "./store/db";
import { Orchestrator, type SyncOutcome } from "./sync/orchestrator";
import { outcomeMessage } from "./ui/messages";
import { statusText } from "./ui/status-bar";
import { ObsidianVaultAdapter } from "./vault/obsidian-adapter";

export default class UnivaultPlugin extends Plugin {
	settings!: UnivaultSettings;
	session!: SessionStore;
	store!: StateStore;
	orchestrator!: Orchestrator;

	async onload(): Promise<void> {
		this.settings = readSettings(defaultSettings(Platform), await this.loadData());
		this.session = new SessionStore(this.app, (input, init) => fetch(input, init));
		this.store = await StateStore.open(this.session.vaultId());
		this.orchestrator = new Orchestrator({
			session: () => this.session.client(),
			settings: () => this.settings,
			store: this.store,
			vault: new ObsidianVaultAdapter(this.app.vault),
		});

		const statusBar = this.addStatusBarItem();
		statusBar.addClass("mod-clickable");
		const render = () => statusBar.setText(statusText(this.orchestrator.state, this.orchestrator.lastSyncAt));
		this.orchestrator.onChange(render);
		render();
		this.registerDomEvent(statusBar, "click", () => void this.syncNow());

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.syncNow(),
		});
		this.addSettingTab(new UnivaultSettingTab(this.app, this));
	}

	onunload(): void {
		this.store?.close();
	}

	async syncNow(): Promise<SyncOutcome> {
		const outcome = await this.orchestrator.sync("manual");
		new Notice(outcomeMessage(outcome));
		return outcome;
	}

	async updateSettings(change: Partial<UnivaultSettings>): Promise<void> {
		const next = { ...this.settings, ...change };
		const moved = next.repository !== this.settings.repository || next.branch !== this.settings.branch;
		this.settings = next;
		await this.saveData(this.settings);
		if (moved) await this.store.discardAnchor();
	}
}
