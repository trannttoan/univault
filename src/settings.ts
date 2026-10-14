import { type App, PluginSettingTab, Setting } from "obsidian";
import { UnivaultError } from "./errors";
import type UnivaultPlugin from "./main";
import { errorMessage } from "./ui/messages";

export interface UnivaultSettings {
	repository: string;
	branch: string;
	deviceName: string;
}

export function defaultSettings(platform: {
	isAndroidApp: boolean;
	isIosApp: boolean;
	isMacOS: boolean;
	isWin: boolean;
	isLinux: boolean;
}): UnivaultSettings {
	const deviceName = platform.isAndroidApp
		? "Android"
		: platform.isIosApp
			? "iOS"
			: platform.isMacOS
				? "Mac"
				: platform.isWin
					? "Windows"
					: platform.isLinux
						? "Linux"
						: "Desktop";
	return { repository: "", branch: "main", deviceName };
}

// Only known preference keys are kept; nothing else from data.json survives.
export function readSettings(defaults: UnivaultSettings, data: unknown): UnivaultSettings {
	const saved = (data ?? {}) as Partial<Record<keyof UnivaultSettings, unknown>>;
	const pick = (key: keyof UnivaultSettings) => (typeof saved[key] === "string" ? (saved[key] as string) : defaults[key]);
	return { repository: pick("repository"), branch: pick("branch"), deviceName: pick("deviceName") };
}

export class UnivaultSettingTab extends PluginSettingTab {
	private signInStatus: string | null = null;

	constructor(
		app: App,
		private readonly plugin: UnivaultPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const login = this.plugin.session.login();
		let token = "";

		new Setting(containerEl)
			.setName("GitHub token")
			.setDesc(this.signInStatus ?? (login ? `Signed in as ${login}` : "Fine-grained token with Contents read and write."))
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("github_pat_…").onChange((value) => {
					token = value;
				});
			})
			.addButton((button) =>
				button.setButtonText("Sign in").onClick(async () => {
					try {
						this.signInStatus = `Signed in as ${await this.plugin.session.signInWithToken(token)}`;
					} catch (error) {
						this.signInStatus = errorMessage(error instanceof UnivaultError ? error.code : "unknown");
					}
					this.display();
				}),
			);

		new Setting(containerEl)
			.setName("Repository")
			.setDesc("owner/name of a private repository.")
			.addText((text) =>
				text
					.setPlaceholder("owner/vault")
					.setValue(this.plugin.settings.repository)
					.onChange((value) => this.plugin.updateSettings({ repository: value.trim() })),
			);

		new Setting(containerEl)
			.setName("Branch")
			.addText((text) =>
				text.setValue(this.plugin.settings.branch).onChange((value) => this.plugin.updateSettings({ branch: value.trim() })),
			);

		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Shown in each commit this device makes.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.deviceName)
					.onChange((value) => this.plugin.updateSettings({ deviceName: value.trim() })),
			);
	}
}
