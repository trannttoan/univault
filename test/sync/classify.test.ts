import { describe, expect, it } from "vitest";
import type { IndexEntry } from "../../src/store/db";
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

// Rows are local changes, columns remote changes, in the order of L and R.
const WITH_ANCHOR: Record<string, Outcome[]> = {
	none: ["noop", "download", "download", "download", "download", "noop"],
	"added A": ["upload", "noop", "conflict", "noop", "conflict", "upload"],
	"modified A": ["upload", "noop", "conflict", "noop", "conflict", "upload"],
	deleted: ["noop", "download", "download", "download", "download", "noop"],
};

describe("classify with an anchor", () => {
	const table = Object.keys(L).flatMap((l) => Object.keys(R).map((r, i) => [l, r, WITH_ANCHOR[l]?.[i]] as const));

	it("covers every (local, remote) pair", () => {
		expect(table).toHaveLength(Object.keys(L).length * Object.keys(R).length);
		expect(table.every(([, , expected]) => expected !== undefined)).toBe(true);
	});

	it.each(table)("local %s, remote %s → %s", (l, r, expected) => {
		expect(classify(L[l], R[r])).toBe(expected);
	});
});

// Without an anchor each side only ever reports "added".
describe("classify without an anchor", () => {
	const table: [string, string, Outcome][] = [
		["none", "none", "noop"],
		["none", "added A", "download"],
		["none", "added B", "download"],
		["added A", "none", "upload"],
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

describe("classify against the index entry", () => {
	const entry = (blobSha: string): IndexEntry => ({ path: "p", mtime: 1, size: 1, blobSha, mode: "100644" });
	const C = "c".repeat(40);

	it("merges a path both sides changed to different content", () => {
		expect(classify(L["modified A"], R["modified B"], entry(C))).toBe("merge");
	});

	it("treats a remote change back to the base as no remote change", () => {
		expect(classify(L["modified A"], R["modified B"], entry(B))).toBe("upload");
		expect(classify(undefined, R["modified B"], entry(B))).toBe("noop");
	});

	it("keeps both sides reaching the same content a noop", () => {
		expect(classify(L["modified A"], R["modified A"], entry(C))).toBe("noop");
	});
});
