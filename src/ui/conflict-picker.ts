import { type App, Modal } from "obsidian";
import type { PendingConflict } from "../store/db";
import type { Choice, Orchestrator } from "../sync/orchestrator";

const CHOICES: [Choice, string][] = [
	["mine", "Keep mine"],
	["theirs", "Keep theirs"],
	["both", "Keep both"],
];

// Only records the answer; the orchestrator applies it at the next sync. Closing without
// an answer (Escape, the close button) keeps both.
export class ConflictPicker extends Modal {
	private chosen: Choice | null = null;

	constructor(
		app: App,
		private readonly conflict: PendingConflict,
		private readonly onChoose: (choice: Choice) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { path, remoteDevice, remoteLogin, remoteTime } = this.conflict;
		this.setTitle(`Conflict in ${path}`);
		const who = remoteLogin ? `${remoteDevice} (${remoteLogin})` : remoteDevice;
		const when = remoteTime ? ` on ${new Date(remoteTime).toLocaleString()}` : "";
		this.contentEl.createEl("p", { text: `Changed on this device and on ${who}${when}.` });
		for (const [choice, label] of CHOICES) {
			this.contentEl.createEl("button", { text: label }).addEventListener("click", () => {
				this.chosen = choice;
				this.close();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
		this.onChoose(this.chosen ?? "both");
	}
}

export function pickConflict(app: App, conflict: PendingConflict): Promise<Choice> {
	return new Promise((resolve) => new ConflictPicker(app, conflict, resolve).open());
}

// One picker at a time, in path order. Each answer is stored before the next picker opens;
// `answered` then starts the sync that applies it.
export async function pickInTurn(app: App, orchestrator: Orchestrator, answered: () => void): Promise<void> {
	for (;;) {
		const next = (await orchestrator.conflicts()).find((c) => c.choice === null);
		if (!next) return;
		await orchestrator.recordChoice(next, await pickConflict(app, next));
		answered();
	}
}
