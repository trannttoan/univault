// Runtime stand-in for the `obsidian` module, which ships types only.
// Tests import the real types from "obsidian" and these classes from here.

import { FakeVault } from "./vault";

export class App {
	readonly vault = new FakeVault();
	readonly localStorage = new Map<string, unknown>();

	loadLocalStorage(key: string): unknown {
		return this.localStorage.has(key) ? structuredClone(this.localStorage.get(key)) : null;
	}

	saveLocalStorage(key: string, data: unknown): void {
		if (data === null) this.localStorage.delete(key);
		else this.localStorage.set(key, structuredClone(data));
	}
}

export const Platform = {
	isAndroidApp: false,
	isIosApp: false,
	isMacOS: true,
	isWin: false,
	isLinux: false,
	isMobile: false,
	isDesktop: true,
};

export interface Command {
	id: string;
	name: string;
	callback?: () => unknown;
}

export class FakeElement {
	text = "";
	type = "";

	readonly classes: string[] = [];
	readonly listeners = new Map<string, () => unknown>();

	setText(text: string): void {
		this.text = text;
	}

	addClass(name: string): void {
		this.classes.push(name);
	}

	empty(): void {}
}

export class Notice {
	static readonly shown: string[] = [];

	constructor(readonly message: string) {
		Notice.shown.push(message);
	}
}

export class Plugin {
	readonly statusBarItems: FakeElement[] = [];
	readonly commands: Command[] = [];
	readonly settingTabs: PluginSettingTab[] = [];
	readonly ribbonIcons: { icon: string; title: string; callback: () => unknown }[] = [];
	data: unknown = null;

	constructor(
		readonly app: App,
		readonly manifest: unknown,
	) {}

	addStatusBarItem(): FakeElement {
		const el = new FakeElement();
		this.statusBarItems.push(el);
		return el;
	}

	addRibbonIcon(icon: string, title: string, callback: () => unknown): FakeElement {
		this.ribbonIcons.push({ icon, title, callback });
		return new FakeElement();
	}

	addCommand(command: Command): Command {
		this.commands.push(command);
		return command;
	}

	registerDomEvent(el: FakeElement, type: string, callback: () => unknown): void {
		el.listeners.set(type, callback);
	}

	addSettingTab(tab: PluginSettingTab): void {
		this.settingTabs.push(tab);
	}

	async loadData(): Promise<unknown> {
		return structuredClone(this.data);
	}

	async saveData(data: unknown): Promise<void> {
		this.data = structuredClone(data);
	}
}

export class PluginSettingTab {
	readonly containerEl = new FakeElement();

	constructor(
		readonly app: App,
		readonly plugin: Plugin,
	) {}
}

// Accepts any chained builder call and ignores it.
export class Setting {
	constructor(readonly containerEl: unknown) {
		return new Proxy(this, { get: (target, key) => (key in target ? Reflect.get(target, key) : () => target) });
	}
}
