export type RefResult = { notModified: true } | { notModified: false; sha: string; etag: string | null };

export interface Commit {
	sha: string;
	treeSha: string;
	parents: string[];
}

export interface TreeEntry {
	path: string;
	mode: string;
	type: "blob" | "tree" | "commit";
	sha: string;
	size?: number;
}

export interface Tree {
	sha: string;
	truncated: boolean;
	entries: TreeEntry[];
}

export interface CompareFile {
	filename: string;
	status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
	sha: string;
	previousFilename?: string;
}

export interface Compare {
	status: "diverged" | "ahead" | "behind" | "identical";
	files: CompareFile[];
}

export interface NewTreeEntry {
	path: string;
	mode: "100644" | "100755";
	type: "blob";
	sha: string;
}
