import { diffArrays } from "diff";

export type ConflictDetail = "overlap" | "binary" | "too-large";

export type MergeResult = { kind: "merged"; bytes: Uint8Array } | { kind: "conflict"; detail: ConflictDetail };

// Past this many inserted plus removed lines per side the diff gives up and the user decides;
// it bounds the diff's time. Measurements are in the TRD Memory rule.
export const MAX_EDIT_LENGTH = 1000;
// Per side; the caller checks it before reading, since a merge holds all three sides at once.
export const MERGE_CAP_BYTES = 1024 * 1024;
// Per side. Memory grows with the line count, so a note of very short lines needs this bound
// as well as the byte cap to stay within the mobile budget.
export const MAX_LINES = 50_000;

// Extensions that are binary for certain, so large media is never sniffed. Nothing is ever
// text by extension.
const BINARY_EXTENSIONS = new Set([
	...["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic", "avif", "psd", "pdf"],
	...["mp3", "wav", "m4a", "ogg", "flac", "aac", "mp4", "mov", "webm", "mkv", "avi"],
	...["zip", "gz", "tgz", "7z", "rar", "docx", "xlsx", "pptx", "epub", "woff", "woff2", "ttf", "otf"],
]);

export function isBinaryPath(path: string): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

interface Hunk {
	// Base lines [start, end) are replaced by `lines`; start === end is a pure insertion.
	start: number;
	end: number;
	lines: string[];
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

// Text is strict UTF-8 with no NUL byte. A BOM is kept as part of the first line.
export function decodeText(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) return null;
	try {
		return decoder.decode(bytes);
	} catch {
		return null;
	}
}

// Each line carries the terminator before it ("\n" or "\r\n"), not after it, so text appended
// after a last line without a newline is an insertion rather than an edit of that line.
export function splitLines(text: string): string[] {
	const lines: string[] = [];
	let start = 0;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
		const end = i > 0 && text[i - 1] === "\r" ? i - 1 : i;
		lines.push(text.slice(start, end));
		start = end;
	}
	if (text.length) lines.push(text.slice(start));
	return lines;
}

// Pure three-way merge of one file (ADR-003). Two edits conflict when they touch the same base
// lines or the same paragraph (a run of non-blank base lines); identical edits agree.
export function merge(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array, path: string): MergeResult {
	if (isBinaryPath(path)) return { kind: "conflict", detail: "binary" };
	if ([base, ours, theirs].some((bytes) => lineCount(bytes) > MAX_LINES)) return { kind: "conflict", detail: "too-large" };
	const texts = [base, ours, theirs].map(decodeText);
	if (texts.some((t) => t === null)) return { kind: "conflict", detail: "binary" };
	const [baseLines, oursLines, theirsLines] = (texts as string[]).map(splitLines) as [string[], string[], string[]];

	const oursHunks = hunks(baseLines, oursLines);
	const theirsHunks = hunks(baseLines, theirsLines);
	if (!oursHunks || !theirsHunks) return { kind: "conflict", detail: "too-large" };

	const agreed = new Set(theirsHunks.filter((t) => oursHunks.some((o) => sameHunk(o, t))));
	const mine = oursHunks.filter((o) => !theirsHunks.some((t) => sameHunk(o, t)));
	const others = theirsHunks.filter((t) => !agreed.has(t));
	const para = paragraphs(baseLines);
	const theirFootprints = others.map((t) => footprint(t, para));
	// Hunks whose lines are replaced at output: same-point insertions become one hunk of theirs'
	// lines then ours', and an insertion the other side's touching edit already holds is dropped.
	const replaced = new Map<Hunk, string[]>();
	for (const o of mine) {
		const mineFootprint = footprint(o, para);
		for (const [i, t] of others.entries()) {
			if (overlaps(mineFootprint, theirFootprints[i] ?? null) || (o.start < t.end && t.start < o.end)) {
				return { kind: "conflict", detail: "overlap" };
			}
			const touching = o.end === t.start || t.end === o.start;
			if (!touching) continue;
			const oInsert = o.start === o.end;
			const tInsert = t.start === t.end;
			if (oInsert && tInsert) {
				// Both filled an empty file: like a file added on both sides, the user decides.
				const lines = o.start > 0 ? stack(t.lines, o.lines) : null;
				if (!lines) return { kind: "conflict", detail: "overlap" };
				replaced.set(t, lines);
				replaced.set(o, []);
			} else if (oInsert || tInsert) {
				// A re-merge: ours may hold theirs' insertion inside a neighboring edit, or the reverse.
				const [insert, edit] = oInsert ? [o, t] : [t, o];
				const holds = edit.end === insert.start ? endsWith(edit.lines, insert.lines) : startsWith(edit.lines, insert.lines);
				if (holds) replaced.set(insert, []);
				else if (sharesText(edit.lines, insert.lines)) return { kind: "conflict", detail: "overlap" };
			}
		}
	}

	const ordered = [...theirsHunks, ...mine].sort((a, b) => a.start - b.start || a.end - b.end);
	const out: string[] = [];
	let pos = 0;
	for (const h of ordered) {
		for (; pos < h.start; pos++) out.push(baseLines[pos] as string);
		for (const line of replaced.get(h) ?? h.lines) out.push(line);
		pos = h.end;
	}
	for (; pos < baseLines.length; pos++) out.push(baseLines[pos] as string);
	return { kind: "merged", bytes: encoder.encode(out.join("")) };
}

// Theirs first, as it was pushed first. What both inserted at the start or the end is kept
// once, so re-merging a stacked result, or a newer theirs that grew the same insertion, adds
// nothing twice. The trim backs off until the two remainders meet at a blank line, so stacked
// paragraphs stay separate paragraphs.
function stack(theirs: string[], ours: string[]): string[] | null {
	let head = 0;
	while (head < theirs.length && head < ours.length && theirs[head] === ours[head]) head++;
	let tail = 0;
	const fits = () => tail < theirs.length - head && tail < ours.length - head;
	while (fits() && theirs[theirs.length - 1 - tail] === ours[ours.length - 1 - tail]) tail++;
	for (;;) {
		const theirsRest = theirs.slice(head, theirs.length - tail);
		const oursRest = ours.slice(head, ours.length - tail);
		if (sharesText(theirsRest, oursRest)) return null;
		const last = theirsRest[theirsRest.length - 1];
		const first = oursRest[0];
		if (last === undefined || first === undefined || isBlank(last) || isBlank(first)) {
			return [...theirs.slice(0, head), ...theirsRest, ...oursRest, ...theirs.slice(theirs.length - tail)];
		}
		if (tail > 0) tail--;
		else if (head > 0) head--;
		else return null;
	}
}

function lineCount(bytes: Uint8Array): number {
	let count = 1;
	for (const byte of bytes) if (byte === 0x0a) count++;
	return count;
}

function hunks(base: string[], side: string[]): Hunk[] | null {
	const changes = diffArrays(base, side, { maxEditLength: MAX_EDIT_LENGTH });
	if (!changes) return null;
	const result: Hunk[] = [];
	let pos = 0;
	let open: Hunk | null = null;
	for (const change of changes) {
		if (!change.added && !change.removed) {
			open = null;
			pos += change.count;
			continue;
		}
		if (!open) {
			open = { start: pos, end: pos, lines: [] };
			result.push(open);
		}
		if (change.removed) {
			pos += change.count;
			open.end = pos;
		} else {
			for (const line of change.value) open.lines.push(line);
		}
	}
	return result;
}

function sameHunk(a: Hunk, b: Hunk): boolean {
	return a.start === b.start && a.end === b.end && a.lines.length === b.lines.length && a.lines.every((l, i) => l === b.lines[i]);
}

function startsWith(lines: string[], part: string[]): boolean {
	return part.length <= lines.length && part.every((line, i) => line === lines[i]);
}

function endsWith(lines: string[], part: string[]): boolean {
	const offset = lines.length - part.length;
	return offset >= 0 && part.every((line, i) => line === lines[offset + i]);
}

// Whether two runs of lines have a non-blank line in common.
function sharesText(a: string[], b: string[]): boolean {
	const text = new Set(a.filter((line) => !isBlank(line)));
	return b.some((line) => text.has(line));
}

function overlaps(a: [number, number] | null, b: [number, number] | null): boolean {
	return a !== null && b !== null && a[0] <= b[1] && b[0] <= a[1];
}

function isBlank(line: string): boolean {
	return line.trim() === "";
}

// Paragraph number per base line, -1 for blank lines.
function paragraphs(base: string[]): Int32Array {
	const ids = new Int32Array(base.length);
	let id = -1;
	let open = false;
	for (const [i, line] of base.entries()) {
		if (isBlank(line)) {
			ids[i] = -1;
			open = false;
		} else {
			if (!open) id++;
			open = true;
			ids[i] = id;
		}
	}
	return ids;
}

// The paragraphs a hunk touches, as a range of paragraph numbers: those of the base lines it
// replaces, plus a neighbor its new text runs into (no blank line between them), plus the
// enclosing paragraph of an edit strictly inside one. A new paragraph between two touches neither.
function footprint(h: Hunk, para: Int32Array): [number, number] | null {
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	const add = (p: number) => {
		if (p < 0) return;
		lo = Math.min(lo, p);
		hi = Math.max(hi, p);
	};
	for (let i = h.start; i < h.end; i++) add(para[i] as number);
	const left = h.start > 0 ? (para[h.start - 1] as number) : -1;
	const right = h.end < para.length ? (para[h.end] as number) : -1;
	const first = h.lines[0];
	const last = h.lines[h.lines.length - 1];
	if (left === right) add(left);
	if (left >= 0 && (first === undefined ? right >= 0 : !isBlank(first))) add(left);
	if (right >= 0 && (last === undefined ? left >= 0 : !isBlank(last))) add(right);
	return lo <= hi ? [lo, hi] : null;
}
