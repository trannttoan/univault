// Runtime stand-in for the `obsidian` module, which ships types only.
// Tests import the real types from "obsidian" and these classes from here.

export class App {}

export interface Command {
	id: string;
	name: string;
	callback?: () => unknown;
}

export class FakeElement {
	text = "";

	setText(text: string): void {
		this.text = text;
	}
}

export class Plugin {
	readonly statusBarItems: FakeElement[] = [];
	readonly commands: Command[] = [];

	constructor(
		readonly app: App,
		readonly manifest: unknown,
	) {}

	addStatusBarItem(): FakeElement {
		const el = new FakeElement();
		this.statusBarItems.push(el);
		return el;
	}

	addCommand(command: Command): Command {
		this.commands.push(command);
		return command;
	}
}
