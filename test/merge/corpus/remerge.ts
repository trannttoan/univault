import type { Case } from "./case";

// Ours already holds an earlier merge with theirs, as on a retry after the merged bytes landed.
export const cases: Case[] = [
	{
		name: "re-merging a merge of different paragraphs is unchanged",
		base: "a\n\nb\n\nc\n",
		ours: "A\n\nb\n\nC\n",
		theirs: "a\n\nb\n\nC\n",
		expected: "A\n\nb\n\nC\n",
	},
	{
		name: "re-merging stacked appends is unchanged",
		base: "Intro.",
		ours: "Intro.\n\nTheirs.\n\nMine.",
		theirs: "Intro.\n\nTheirs.",
		expected: "Intro.\n\nTheirs.\n\nMine.",
	},
	{
		name: "re-merging after theirs grew the same append keeps each paragraph once",
		base: "Intro.",
		ours: "Intro.\n\nA\n\nB",
		theirs: "Intro.\n\nA\n\nA2",
		expected: "Intro.\n\nA\n\nA2\n\nB",
	},
	{
		name: "re-merging a continued last line and an appended paragraph is unchanged",
		base: "Intro.",
		ours: "Intro. More.\n\nTheirs.",
		theirs: "Intro.\n\nTheirs.",
		expected: "Intro. More.\n\nTheirs.",
	},
	{
		name: "re-merging after theirs grew an append next to an edited last line asks",
		base: "Intro.",
		ours: "Intro. More.\n\nA",
		theirs: "Intro.\n\nA\n\nA2",
		expected: "conflict",
	},
	{
		name: "re-merging after theirs edited the same paragraph again asks",
		base: "a\n\nb\n\nc\n",
		ours: "A\n\nb\n\nC\n",
		theirs: "a\n\nb\n\nC, again\n",
		expected: "conflict",
	},
];
