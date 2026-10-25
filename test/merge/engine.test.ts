import { describe, expect, it } from "vitest";
import { MAX_EDIT_LENGTH, merge, splitLines } from "../../src/merge/engine";

const enc = (text: string) => new TextEncoder().encode(text);
const run = (base: string, ours: string, theirs: string) => {
	const result = merge(enc(base), enc(ours), enc(theirs), "note.md");
	return result.kind === "merged" ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(result.bytes) : result;
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

	it("treats bytes with a NUL or invalid UTF-8 as binary, and a known binary extension as binary unread", () => {
		const nul = merge(enc("a\n"), enc("a\0\n"), enc("b\n"), "n.md");
		expect(nul).toEqual({ kind: "conflict", detail: "binary" });
		const invalid = merge(enc("a"), new Uint8Array([0xc3, 0x28]), enc("b"), "n.md");
		expect(invalid).toEqual({ kind: "conflict", detail: "binary" });
		expect(merge(enc("a\n\nb"), enc("A\n\nb"), enc("a\n\nB"), "image.PNG")).toEqual({ kind: "conflict", detail: "binary" });
		expect(run("a\n\nb", "A\n\nb", "a\n\nB")).toBe("A\n\nB");
	});

	it("keeps a BOM as part of the first line", () => {
		expect(run("\uFEFFone\n\ntwo\n", "\uFEFFONE\n\ntwo\n", "\uFEFFone\n\nTWO\n")).toBe("\uFEFFONE\n\nTWO\n");
	});

	it("gives up past the edit cap on either side", () => {
		const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}\n\n`).join("");
		const base = lines(MAX_EDIT_LENGTH, "line");
		const rewritten = lines(MAX_EDIT_LENGTH, "rewritten");
		expect(run(base, rewritten, `${base}tail\n`)).toEqual({ kind: "conflict", detail: "too-large" });
	});
});
