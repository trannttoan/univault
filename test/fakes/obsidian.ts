// Runtime stand-in for the `obsidian` module, which ships types only.
// Tests import the real types from "obsidian" and these classes from here.

import { FakeVault } from "./vault";

export class App {
	readonly vault = new FakeVault();
	readonly localStorage = new Map<string, unknown>();
	readonly workspace = new Workspace();

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

export class Workspace {
	readonly opened: string[] = [];

	async openLinkText(linktext: string): Promise<void> {
		this.opened.push(linktext);
	}
}

export class FakeElement {
	text = "";
	type = "";

	readonly classes: string[] = [];
	readonly listeners = new Map<string, (event?: { preventDefault(): void }) => unknown>();
	readonly children: FakeElement[] = [];

	constructor(readonly tag = "div") {}

	setText(text: string): void {
		this.text = text;
	}

	createEl(tag: string, options: { text?: string } = {}): FakeElement {
		const el = new FakeElement(tag);
		el.text = options.text ?? "";
		this.children.push(el);
		return el;
	}

	addEventListener(type: string, callback: (event?: { preventDefault(): void }) => unknown): void {
		this.listeners.set(type, callback);
	}

	click(): void {
		this.listeners.get("click")?.({ preventDefault() {} });
	}

	// Every element below this one, depth first.
	descendants(): FakeElement[] {
		return this.children.flatMap((child) => [child, ...child.descendants()]);
	}

	addClass(name: string): void {
		this.classes.push(name);
	}

	empty(): void {
		this.children.length = 0;
	}
}

export class Modal {
	// Modals currently open, oldest first.
	static readonly open: Modal[] = [];
	readonly titleEl = new FakeElement();
	readonly contentEl = new FakeElement();

	constructor(readonly app: App) {}

	open(): void {
		Modal.open.push(this);
		this.onOpen();
	}

	close(): void {
		const at = Modal.open.indexOf(this);
		if (at < 0) return;
		Modal.open.splice(at, 1);
		this.onClose();
	}

	setTitle(title: string): this {
		this.titleEl.setText(title);
		return this;
	}

	onOpen(): void {}

	onClose(): void {}

	// Title and content text, for assertions.
	text(): string {
		return [this.titleEl.text, ...this.contentEl.descendants().map((el) => el.text)].join("\n");
	}

	button(label: string): FakeElement | undefined {
		return this.contentEl.descendants().find((el) => el.tag === "button" && el.text === label);
	}
}

export class Notice {
	static readonly shown: string[] = [];
	static readonly instances: Notice[] = [];
	readonly messageEl = new FakeElement();

	constructor(readonly message: string) {
		Notice.shown.push(message);
		Notice.instances.push(this);
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
