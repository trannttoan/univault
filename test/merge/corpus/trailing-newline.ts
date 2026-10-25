import type { Case } from "./case";

export const cases: Case[] = [
	{
		name: "a trailing newline added on one side and an edit on the other merge",
		base: "one\n\ntwo",
		ours: "one\n\ntwo\n",
		theirs: "ONE\n\ntwo",
		expected: "ONE\n\ntwo\n",
	},
	{
		name: "a trailing newline added on both sides merges once",
		base: "one\n\ntwo",
		ours: "one\n\ntwo\n",
		theirs: "one\n\ntwo\n",
		expected: "one\n\ntwo\n",
	},
	{
		name: "a trailing newline removed on one side and an edit on the other merge",
		base: "one\n\ntwo\n",
		ours: "one\n\ntwo",
		theirs: "ONE\n\ntwo\n",
		expected: "ONE\n\ntwo",
	},
	{
		name: "paragraphs appended to a note without a final newline stack",
		base: "Intro.",
		ours: "Intro.\n\nMine.",
		theirs: "Intro.\n\nTheirs.",
		expected: "Intro.\n\nTheirs.\n\nMine.",
	},
	{
		name: "paragraphs appended to a note with a final newline stack",
		base: "Intro.\n",
		ours: "Intro.\n\nMine.\n",
		theirs: "Intro.\n\nTheirs.\n",
		expected: "Intro.\n\nTheirs.\n\nMine.\n",
	},
	{
		name: "text continued on the last line and a new paragraph after it merge",
		base: "Intro.",
		ours: "Intro. More.",
		theirs: "Intro.\n\nTheirs.",
		expected: "Intro. More.\n\nTheirs.",
	},
];
