import type { Case } from "./case";

// An empty base: the file was created on both sides, or was empty before both edits.
export const cases: Case[] = [
	{
		name: "different content added to an empty file on both sides conflicts",
		base: "",
		ours: "# Today\n\nFrom here.\n",
		theirs: "# Today\n\nFrom there.\n",
		expected: "conflict",
	},
	{
		name: "identical content added on both sides merges once",
		base: "",
		ours: "# Today\n",
		theirs: "# Today\n",
		expected: "# Today\n",
	},
	{
		name: "content added on one side only is taken",
		base: "",
		ours: "Only here.\n",
		theirs: "",
		expected: "Only here.\n",
	},
	{
		name: "the same template with different bodies conflicts",
		base: "",
		ours: "---\ntags: daily\n---\n\nRan errands.\n",
		theirs: "---\ntags: daily\n---\n\nWrote code.\n",
		expected: "conflict",
	},
];
