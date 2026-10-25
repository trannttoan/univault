import type { Case } from "./case";

const P = "First paragraph.\n\nSecond paragraph,\nover two lines.\n\nThird paragraph.\n";

export const cases: Case[] = [
	{
		name: "two different rewrites of one paragraph conflict",
		base: P,
		ours: "First paragraph.\n\nSecond, rewritten here.\n\nThird paragraph.\n",
		theirs: "First paragraph.\n\nSecond, rewritten there,\nalso over two lines.\n\nThird paragraph.\n",
		expected: "conflict",
	},
	{
		name: "a rewrite of a paragraph and an edit to one of its lines conflict",
		base: P,
		ours: "First paragraph.\n\nAll new second paragraph.\n\nThird paragraph.\n",
		theirs: "First paragraph.\n\nSecond paragraph,\nover two lines, edited.\n\nThird paragraph.\n",
		expected: "conflict",
	},
	{
		name: "rewrites of the first and the last paragraph merge",
		base: P,
		ours: "First, rewritten.\n\nSecond paragraph,\nover two lines.\n\nThird paragraph.\n",
		theirs: "First paragraph.\n\nSecond paragraph,\nover two lines.\n\nThird, rewritten\nas two lines.\n",
		expected: "First, rewritten.\n\nSecond paragraph,\nover two lines.\n\nThird, rewritten\nas two lines.\n",
	},
	{
		name: "a deleted paragraph and an edit to another paragraph merge",
		base: "p1\n\np2\n\np3\n",
		ours: "p1\n\np3\n",
		theirs: "p1\n\np2\n\nP3\n",
		expected: "p1\n\nP3\n",
	},
	{
		name: "a deleted paragraph and an edit to that paragraph conflict",
		base: "p1\n\np2\n\np3\n",
		ours: "p1\n\np3\n",
		theirs: "p1\n\nP2\n\np3\n",
		expected: "conflict",
	},
	{
		name: "identical rewrites of one paragraph merge",
		base: P,
		ours: "First paragraph.\n\nSecond, agreed.\n\nThird paragraph.\n",
		theirs: "First paragraph.\n\nSecond, agreed.\n\nThird paragraph.\n",
		expected: "First paragraph.\n\nSecond, agreed.\n\nThird paragraph.\n",
	},
];
