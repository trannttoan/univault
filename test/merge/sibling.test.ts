import { describe, expect, it } from "vitest";
import { siblingPath } from "../../src/merge/sibling";
import { canonicalizeRepoPath } from "../../src/vault/paths";

const WHEN = new Date(2026, 9, 25, 9, 5);

describe("siblingPath", () => {
	it("names the device and local time before the extension, in the note's folder", () => {
		expect(siblingPath("notes/Daily note.md", "Phone", WHEN)).toBe("notes/Daily note (conflict from Phone 2026-10-25 09.05).md");
	});

	it("replaces characters a filesystem or a link would refuse, and leading dots", () => {
		const name = siblingPath("a.md", '..My/Mac:\\*?"<>|#^[x]\n2', WHEN);
		expect(name).toBe("a (conflict from My-Mac-----------x- 2 2026-10-25 09.05).md");
		expect(siblingPath("a.md", " ... ", WHEN)).toBe("a (conflict from another device 2026-10-25 09.05).md");
	});

	it("appends the suffix to a name without an extension and to a dotfile", () => {
		expect(siblingPath("README", "Phone", WHEN)).toBe("README (conflict from Phone 2026-10-25 09.05)");
		expect(siblingPath("dir/.gitignore", "Phone", WHEN)).toBe("dir/.gitignore (conflict from Phone 2026-10-25 09.05)");
		expect(siblingPath("archive.tar.gz", "Phone", WHEN)).toBe("archive.tar (conflict from Phone 2026-10-25 09.05).gz");
	});

	it("keeps the file name under 200 bytes however long the device or note name is", () => {
		const bytes = (path: string) => new TextEncoder().encode(path.slice(path.lastIndexOf("/") + 1)).length;
		const device = siblingPath("a.md", "é".repeat(300), WHEN);
		expect(device).toBe(`a (conflict from ${"é".repeat(32)} 2026-10-25 09.05).md`);
		const note = siblingPath(`notes/${"n".repeat(250)}.md`, "Phone", WHEN, 2);
		expect(bytes(note)).toBeLessThanOrEqual(200);
		expect(note).toMatch(/^notes\/n+ \(conflict from Phone 2026-10-25 09\.05 2\)\.md$/);
	});

	it("drops invisible format characters and returns NFC", () => {
		expect(siblingPath("a.md", "Ph\u202Eone\u200B", WHEN)).toBe("a (conflict from Ph-one- 2026-10-25 09.05).md");
		const nfd = siblingPath("Cafe\u0301.md", "Ange\u0301", WHEN);
		expect(nfd).toBe("Caf\u00e9 (conflict from Ang\u00e9 2026-10-25 09.05).md");
	});

	it("numbers a second copy from the same minute", () => {
		expect(siblingPath("a.md", "Phone", WHEN, 2)).toBe("a (conflict from Phone 2026-10-25 09.05 2).md");
	});

	it("produces paths the repository path check accepts", () => {
		for (const device of ["Phone", "../..", "a/b\\c", "\r\n", ".obsidian"]) {
			const path = siblingPath("notes/x.md", device, WHEN, 3);
			expect(canonicalizeRepoPath(path, ".obsidian", ".obsidian/plugins/univault")).toBe(path);
		}
	});
});
