import { describe, expect, it } from "vitest";
import { type Outcome, classify, classifyAll } from "../../src/sync/classify";
import type { LocalChange } from "../../src/sync/local-delta";
import type { RemoteChange } from "../../src/sync/remote-delta";

const A = "a".repeat(40);
const B = "b".repeat(40);
const local = (kind: "added" | "modified", blobSha: string): LocalChange => ({ kind, vaultPath: "p", blobSha, mtime: 1, size: 1 });
const remote = (kind: "added" | "modified", sha: string): RemoteChange => ({ kind, sha });

const L: Record<string, LocalChange | undefined> = {
	none: undefined,
	"added A": local("added", A),
	"modified A": local("modified", A),
	deleted: { kind: "deleted" },
};
const R: Record<string, RemoteChange | undefined> = {
	none: undefined,
	"added A": remote("added", A),
	"added B": remote("added", B),
	"modified A": remote("modified", A),
	"modified B": remote("modified", B),
	removed: { kind: "removed" },
};

describe("classify with an anchor", () => {
	const table: [string, string, Outcome][] = [
		["none", "none", "noop"],
		["none", "added A", "download"],
		["none", "modified B", "download"],
		["none", "removed", "noop"],
		["added A", "none", "upload"],
		["added A", "added A", "noop"],
		["added A", "added B", "conflict"],
		["added A", "removed", "upload"],
		["modified A", "none", "upload"],
		["modified A", "modified A", "noop"],
		["modified A", "modified B", "conflict"],
		["modified A", "removed", "upload"],
		["deleted", "none", "noop"],
		["deleted", "modified B", "download"],
		["deleted", "removed", "noop"],
	];
	it.each(table)("local %s, remote %s → %s", (l, r, expected) => {
		expect(classify(L[l], R[r])).toBe(expected);
	});
});

describe("classify without an anchor", () => {
	const table: [string, string, Outcome][] = [
		["added A", "none", "upload"],
		["none", "added A", "download"],
		["added A", "added A", "noop"],
		["added A", "added B", "conflict"],
	];
	it.each(table)("local %s, remote %s → %s", (l, r, expected) => {
		expect(classify(L[l], R[r])).toBe(expected);
	});
});

it("classifies the union of both deltas", () => {
	const outcomes = classifyAll(
		new Map([
			["up.md", local("added", A)],
			["same.md", local("modified", A)],
		]),
		new Map([
			["down.md", remote("added", B)],
			["same.md", remote("modified", A)],
		]),
	);
	expect(Object.fromEntries(outcomes)).toEqual({ "up.md": "upload", "same.md": "noop", "down.md": "download" });
});
