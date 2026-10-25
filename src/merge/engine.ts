import { diffArrays } from "diff";

export type ConflictDetail = "overlap" | "binary" | "too-large";

export type MergeResult = { kind: "merged"; bytes: Uint8Array } | { kind: "conflict"; detail: ConflictDetail };

// Past this many inserted plus removed lines per side the diff gives up and the user decides.
export const MAX_EDIT_LENGTH = 2000;
// Per side; the caller checks it before reading, since a merge holds all three sides at once.
export const MERGE_CAP_BYTES = 1024 * 1024;

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

// Pure three-way merge of one file. Two edits conflict when they touch the same base lines or
// the same paragraph (a run of non-blank base lines); edits made identically on both sides agree.
export function merge(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array, path: string): MergeResult {
	if (isBinaryPath(path)) return { kind: "conflict", detail: "binary" };
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
	for (const o of mine) {
		const mineFootprint = footprint(o, para);
		for (const [i, t] of others.entries()) {
			if (clash(o, t, mineFootprint, theirFootprints[i] ?? null)) return { kind: "conflict", detail: "overlap" };
		}
	}

	// Theirs before ours at a shared insertion point: theirs was pushed first.
	const ordered = [...theirsHunks.map((h) => ({ h, side: 0 })), ...mine.map((h) => ({ h, side: 1 }))].sort(
		(a, b) => a.h.start - b.h.start || a.h.end - b.h.end || a.side - b.side,
	);
	const out: string[] = [];
	let pos = 0;
	for (const { h } of ordered) {
		for (; pos < h.start; pos++) out.push(baseLines[pos] as string);
		for (const line of h.lines) out.push(line);
		pos = h.end;
	}
	for (; pos < baseLines.length; pos++) out.push(baseLines[pos] as string);
	return { kind: "merged", bytes: encoder.encode(out.join("")) };
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

function clash(a: Hunk, b: Hunk, aPara: [number, number] | null, bPara: [number, number] | null): boolean {
	if (a.start < b.end && b.start < a.end) return true;
	// Same-point insertions are stacked theirs-then-ours, which needs ours to open with a terminator.
	if (a.start === a.end && b.start === b.end && a.start === b.start && !/^\r?\n/.test(a.lines[0] ?? "")) return true;
	return aPara !== null && bPara !== null && aPara[0] <= bPara[1] && bPara[0] <= aPara[1];
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
