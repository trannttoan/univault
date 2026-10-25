import type { Case } from "./case";

export const cases: Case[] = [
	{
		name: "a bom is kept through edits to different paragraphs",
		base: "﻿one\n\ntwo\n",
		ours: "﻿ONE\n\ntwo\n",
		theirs: "﻿one\n\nTWO\n",
		expected: "﻿ONE\n\nTWO\n",
	},
	{
		name: "a bom removed on one side and an edit to another paragraph merge",
		base: "﻿one\n\ntwo\n",
		ours: "one\n\ntwo\n",
		theirs: "﻿one\n\nTWO\n",
		expected: "one\n\nTWO\n",
	},
	{
		name: "edits to the first line of a file with a bom conflict",
		base: "﻿one\n",
		ours: "﻿ONE\n",
		theirs: "﻿One\n",
		expected: "conflict",
	},
];
