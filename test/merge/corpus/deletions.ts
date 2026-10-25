import type { Case } from "./case";

export const cases: Case[] = [
	{
		name: "the same paragraph deleted on both sides merges",
		base: "p1\n\np2\n\np3\n",
		ours: "p1\n\np3\n",
		theirs: "p1\n\np3\n",
		expected: "p1\n\np3\n",
	},
	{
		name: "the same line deleted inside a paragraph on both sides merges",
		base: "a\nb\nc\n",
		ours: "a\nc\n",
		theirs: "a\nc\n",
		expected: "a\nc\n",
	},
	{
		name: "overlapping deletions of different extent conflict",
		base: "a\nb\nc\nd\n",
		ours: "a\nd\n",
		theirs: "a\nc\nd\n",
		expected: "conflict",
	},
	{
		name: "the same paragraph deleted on both sides with another edit on one merges",
		base: "p1\n\np2\n\np3\n",
		ours: "p1\n\np3\n",
		theirs: "P1\n\np3\n",
		expected: "P1\n\np3\n",
	},
];
