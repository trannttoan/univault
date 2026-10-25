import { describe, expect, it } from "vitest";
import { MAX_EDIT_LENGTH, MERGE_CAP_BYTES, merge } from "../../src/merge/engine";
import { cases as adjacentLines } from "./corpus/adjacent-lines";
import { cases as bom } from "./corpus/bom";
import { cases as bothAdded } from "./corpus/both-added";
import { cases as boundaries } from "./corpus/boundaries";
import type { Case } from "./corpus/case";
import { cases as deletions } from "./corpus/deletions";
import { cases as lineEndings } from "./corpus/line-endings";
import { cases as paragraphRewrites } from "./corpus/paragraph-rewrites";
import { cases as remerge } from "./corpus/remerge";
import { cases as trailingNewline } from "./corpus/trailing-newline";

const CATEGORIES: Record<string, Case[]> = {
	"adjacent-line edits": adjacentLines,
	"paragraph rewrites": paragraphRewrites,
	"crlf and mixed endings": lineEndings,
	"trailing-newline differences": trailingNewline,
	"both-added files": bothAdded,
	"insertions at a paragraph boundary": boundaries,
	"both sides deleting lines": deletions,
	bom,
	"re-merging a merged result": remerge,
};

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
const run = (base: string, ours: string, theirs: string) => {
	const result = merge(enc(base), enc(ours), enc(theirs), "note.md");
	return result.kind === "merged" ? dec(result.bytes) : "conflict";
};

describe("merge corpus", () => {
	it("has at least 30 cases, and some in every category", () => {
		expect(Object.values(CATEGORIES).flat().length).toBeGreaterThanOrEqual(30);
		for (const cases of Object.values(CATEGORIES)) expect(cases.length).toBeGreaterThan(0);
	});

	for (const [category, cases] of Object.entries(CATEGORIES)) {
		describe(category, () => {
			it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
				const result = run(c.base, c.ours, c.theirs);
				expect(result).toBe(c.expected);
				// Swapping sides never changes whether it conflicts.
				expect(run(c.base, c.theirs, c.ours) === "conflict").toBe(result === "conflict");
				// A retry merges its own result again. Blank lines can align differently the second
				// time, which may turn it into a conflict, but never into a different merge.
				if (result !== "conflict") {
					expect([result, "conflict"]).toContain(run(c.base, result, c.theirs));
					expect([result, "conflict"]).toContain(run(c.base, result, c.ours));
				}
			});
		});
	}
});

// A 1 MB note of two-line paragraphs; ours rewrites a block just inside the edit cap, theirs
// edits one far-away line. Durations are printed for the TRD.
describe("merge cost at the caps", () => {
	const paragraph = (i: number) => `Paragraph ${i}, first line of some ordinary note text.\nSecond line ${i}.\n\n`;
	const paragraphs: string[] = [];
	for (let size = 0, i = 0; size < MERGE_CAP_BYTES - 200; i++) {
		paragraphs.push(paragraph(i));
		size += paragraph(i).length;
	}
	const base = paragraphs.join("");
	// Each rewritten paragraph is three changed lines: two removed and added, the blank kept.
	const rewrite = (count: number) =>
		paragraphs.map((p, i) => (i >= 100 && i < 100 + count ? p.replace("Paragraph", "Rewritten").replace("Second", "Other") : p)).join("");
	const theirs = paragraphs.map((p, i) => (i === paragraphs.length - 5 ? p.replace("first", "FIRST") : p)).join("");
	const atCap = Math.floor(MAX_EDIT_LENGTH / 4);

	it("merges a 1 MB note at the edit cap within 300 ms", () => {
		expect(base.length).toBeLessThanOrEqual(MERGE_CAP_BYTES);
		merge(enc("a"), enc("b\n\na"), enc("a\n\nc"), "warm-up.md");
		const ours = rewrite(atCap);
		const started = performance.now();
		const result = merge(enc(base), enc(ours), enc(theirs), "big.md");
		const elapsed = performance.now() - started;
		console.log(`merge 1 MB, ${atCap * 4} edited lines on one side: ${elapsed.toFixed(0)} ms`);
		expect(result.kind).toBe("merged");
		expect(elapsed).toBeLessThan(300);
	});

	it("gives up quickly just past the edit cap", () => {
		const ours = rewrite(atCap + 1);
		const started = performance.now();
		const result = merge(enc(base), enc(ours), enc(theirs), "big.md");
		const elapsed = performance.now() - started;
		console.log(`merge 1 MB, past the edit cap: ${elapsed.toFixed(0)} ms`);
		expect(result).toEqual({ kind: "conflict", detail: "too-large" });
	});
});
