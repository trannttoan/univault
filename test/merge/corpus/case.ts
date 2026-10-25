// One corpus case: base, ours and theirs as text, and the merge result or "conflict".
export interface Case {
	name: string;
	base: string;
	ours: string;
	theirs: string;
	expected: string | "conflict";
}
