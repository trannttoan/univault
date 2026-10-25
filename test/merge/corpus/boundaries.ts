import type { Case } from "./case";

export const cases: Case[] = [
	{
		name: "new paragraphs inserted between the same two paragraphs stack, theirs first",
		base: "p1\n\np2\n",
		ours: "p1\n\nmine\n\np2\n",
		theirs: "p1\n\ntheirs\n\np2\n",
		expected: "p1\n\ntheirs\n\nmine\n\np2\n",
	},
	{
		name: "a line added to the end of a paragraph and an edit to that paragraph conflict",
		base: "a\nb\n\nc\n",
		ours: "a\nb\nb2\n\nc\n",
		theirs: "A\nb\n\nc\n",
		expected: "conflict",
	},
	{
		name: "a line added to the end of a paragraph and an edit to the next paragraph merge",
		base: "a\nb\n\nc\n",
		ours: "a\nb\nb2\n\nc\n",
		theirs: "a\nb\n\nC\n",
		expected: "a\nb\nb2\n\nC\n",
	},
	{
		name: "a new paragraph before a paragraph and an edit to its first line merge",
		base: "p1\n\np2 line1\np2 line2\n",
		ours: "p1\n\nnew\n\np2 line1\np2 line2\n",
		theirs: "p1\n\nP2 line1\np2 line2\n",
		expected: "p1\n\nnew\n\nP2 line1\np2 line2\n",
	},
	{
		name: "items appended to the same list on both sides conflict",
		base: "- a\n- b\n",
		ours: "- a\n- b\n- c\n",
		theirs: "- a\n- b\n- d\n",
		expected: "conflict",
	},
	{
		name: "a blank line splitting a paragraph and an edit to that paragraph conflict",
		base: "a\nb\n\nc\n",
		ours: "a\n\nb\n\nc\n",
		theirs: "a\nB\n\nc\n",
		expected: "conflict",
	},
];
