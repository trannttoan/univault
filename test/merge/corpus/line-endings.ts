import type { Case } from "./case";

export const cases: Case[] = [
	{
		name: "crlf edits in different paragraphs merge byte for byte",
		base: "one\r\ntwo\r\n\r\nthree\r\n",
		ours: "ONE\r\ntwo\r\n\r\nthree\r\n",
		theirs: "one\r\ntwo\r\n\r\nTHREE\r\n",
		expected: "ONE\r\ntwo\r\n\r\nTHREE\r\n",
	},
	{
		name: "crlf edits in one paragraph conflict",
		base: "one\r\ntwo\r\n",
		ours: "ONE\r\ntwo\r\n",
		theirs: "one\r\nTWO\r\n",
		expected: "conflict",
	},
	{
		name: "mixed endings survive a merge untouched",
		base: "a\r\n\r\nb\n\nc\r\n",
		ours: "A\r\n\r\nb\n\nc\r\n",
		theirs: "a\r\n\r\nb\n\nC\r\n",
		expected: "A\r\n\r\nb\n\nC\r\n",
	},
	{
		name: "converting every ending to lf against a line edit conflicts",
		base: "a\r\n\r\nb\r\n",
		ours: "a\n\nb\n",
		theirs: "a\r\n\r\nB\r\n",
		expected: "conflict",
	},
	{
		name: "crlf paragraphs appended on both sides stack, theirs first",
		base: "Log\r\n",
		ours: "Log\r\n\r\nMine\r\n",
		theirs: "Log\r\n\r\nTheirs\r\n",
		expected: "Log\r\n\r\nTheirs\r\n\r\nMine\r\n",
	},
];
