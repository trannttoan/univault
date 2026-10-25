import { describe, expect, it } from "vitest";
import { merge, splitLines } from "../../src/merge/engine";

const enc = (text: string) => new TextEncoder().encode(text);
const run = (base: string, ours: string, theirs: string) => {
	const result = merge(enc(base), enc(ours), enc(theirs), "note.md");
	return result.kind === "merged" ? new TextDecoder().decode(result.bytes) : result;
};

describe("splitLines", () => {
	it("attaches each terminator to the line after it and loses no byte", () => {
		expect(splitLines("a\nb\r\nc")).toEqual(["a", "\nb", "\r\nc"]);
		expect(splitLines("a\n")).toEqual(["a", "\n"]);
		expect(splitLines("")).toEqual([]);
		expect(splitLines("\r\n")).toEqual(["", "\r\n"]);
		for (const text of ["x\r\r\ny", "\n\n", "only"]) expect(splitLines(text).join("")).toBe(text);
	});
});

describe("merge", () => {
	const base = "Para one.\n\nPara two.\n\nPara three.\n";

	it("applies edits to different paragraphs from both sides", () => {
		expect(run(base, "Para ONE.\n\nPara two.\n\nPara three.\n", "Para one.\n\nPara two.\n\nPara THREE.\n")).toBe(
			"Para ONE.\n\nPara two.\n\nPara THREE.\n",
		);
	});

	it("conflicts on edits to different lines of the same paragraph", () => {
		const twoLines = "First line\nsecond line\n\nOther.\n";
		expect(run(twoLines, "FIRST line\nsecond line\n\nOther.\n", "First line\nSECOND line\n\nOther.\n")).toEqual({
			kind: "conflict",
			detail: "overlap",
		});
	});

	it("keeps CRLF lines byte-exact, including untouched ones", () => {
		const crlf = "a\r\n\r\nb\r\n\r\nc\r\n";
		const result = merge(enc(crlf), enc("A\r\n\r\nb\r\n\r\nc\r\n"), enc("a\r\n\r\nb\r\n\r\nC\r\n"), "n.md");
		expect(result).toEqual({ kind: "merged", bytes: enc("A\r\n\r\nb\r\n\r\nC\r\n") });
	});

	it("treats a trailing newline added on one side as an ordinary change", () => {
		expect(run("one\n\ntwo", "one\n\ntwo\n", "ONE\n\ntwo")).toBe("ONE\n\ntwo\n");
	});

	it("takes identical changes on both sides once", () => {
		expect(run(base, "Para ONE.\n\nPara two.\n\nPara three.\n", "Para ONE.\n\nPara two.\n\nPara three.\n")).toBe(
			"Para ONE.\n\nPara two.\n\nPara three.\n",
		);
	});

	it("stacks two paragraphs appended at the end, theirs first", () => {
		expect(run("Intro.", "Intro.\n\nMine.", "Intro.\n\nTheirs.")).toBe("Intro.\n\nTheirs.\n\nMine.");
	});
});
