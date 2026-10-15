export type ErrorCode =
	| "offline"
	| "rate-limited"
	| "auth-expired"
	| "forbidden"
	| "not-found"
	| "conflict-retry"
	| "tree-too-large"
	| "path-unsafe"
	| "storage-full"
	| "unknown";

// The message is the code itself; only the UI turns codes into words.
// `paths` names the vault paths an error is about, for the UI to list.
export class UnivaultError extends Error {
	readonly paths: string[];

	constructor(
		readonly code: ErrorCode,
		options?: { cause?: unknown; paths?: string[] },
	) {
		super(code, options);
		this.name = "UnivaultError";
		this.paths = options?.paths ?? [];
	}
}
