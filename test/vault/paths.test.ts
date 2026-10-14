import { describe, expect, it } from "vitest";
import { UnivaultError } from "../../src/errors";
import { canonicalizeRepoPath, normalizeVaultPath } from "../../src/vault/paths";

const canon = (path: string) => canonicalizeRepoPath(path, ".obsidian", ".obsidian/plugins/univault");

describe("canonicalizeRepoPath", () => {
	it.each([
		["notes/a.md", "notes/a.md"],
		["notes\\sub\\a.md", "notes/sub/a.md"],
		["notes//sub///a.md", "notes/sub/a.md"],
		["cafe\u0301.md", "caf\u00e9.md"],
		[".obsidian-notes/a.md", ".obsidian-notes/a.md"],
		["..notes/a.md", "..notes/a.md"],
	])("accepts %j as %j", (input, expected) => {
		expect(canon(input)).toBe(expected);
	});

	it.each([
		"..\\x",
		"../escape.md",
		"a/../b.md",
		"./a.md",
		"a/./b.md",
		"/abs",
		"\\abs",
		"C:/x.md",
		"a/",
		"",
		"a\0b.md",
		".obsidian",
		".obsidian/app.json",
		".OBSIDIAN/x",
		".Obsidian/plugins/x/main.js",
		".obsidian/plugins/univault/x",
		".obsidian//plugins/univault/main.js",
	])("rejects %j as path-unsafe", (input) => {
		expect(() => canon(input)).toThrow(UnivaultError);
		try {
			canon(input);
		} catch (error) {
			expect((error as UnivaultError).code).toBe("path-unsafe");
		}
	});

	it("rejects the plugin folder under a custom config directory", () => {
		expect(() => canonicalizeRepoPath("cfg/plugins/univault/main.js", ".obsidian", "cfg/plugins/univault")).toThrow(
			UnivaultError,
		);
	});
});

describe("normalizeVaultPath", () => {
	it("makes NFD and NFC spellings equal", () => {
		expect(normalizeVaultPath("cafe\u0301.md")).toBe(normalizeVaultPath("caf\u00e9.md"));
	});
});
