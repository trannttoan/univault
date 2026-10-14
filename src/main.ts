import { Plugin } from "obsidian";

export default class UnivaultPlugin extends Plugin {
	onload(): void {
		this.addStatusBarItem().setText("Univault: idle");
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {},
		});
	}
}
