import type { Case } from "./case";

export const cases: Case[] = [
	{
		name: "edits to adjacent lines of one paragraph conflict",
		base: "a\nb\nc\n",
		ours: "A\nb\nc\n",
		theirs: "a\nB\nc\n",
		expected: "conflict",
	},
	{
		name: "edits to the last line of a paragraph and the first line of the next merge",
		base: "a\nb\n\nc\nd\n",
		ours: "a\nB\n\nc\nd\n",
		theirs: "a\nb\n\nC\nd\n",
		expected: "a\nB\n\nC\nd\n",
	},
	{
		name: "edits to the first and last items of one list conflict",
		base: "- one\n- two\n- three\n",
		ours: "- ONE\n- two\n- three\n",
		theirs: "- one\n- two\n- THREE\n",
		expected: "conflict",
	},
	{
		name: "single lines separated by a blank line merge",
		base: "a\n\nb\n",
		ours: "A\n\nb\n",
		theirs: "a\n\nB\n",
		expected: "A\n\nB\n",
	},
	{
		name: "the same line edited differently conflicts",
		base: "Meet at noon.\n",
		ours: "Meet at one.\n",
		theirs: "Meet at two.\n",
		expected: "conflict",
	},
	{
		name: "the same line edited identically merges",
		base: "Meet at noon.\n\nBring snacks.\n",
		ours: "Meet at one.\n\nBring snacks.\n",
		theirs: "Meet at one.\n\nBring snacks.\n",
		expected: "Meet at one.\n\nBring snacks.\n",
	},
	{
		name: "a line inserted right after a line the other side edited conflicts",
		base: "a\nb\n\nc\n",
		ours: "A\nb\n\nc\n",
		theirs: "a\nnew\nb\n\nc\n",
		expected: "conflict",
	},
];
