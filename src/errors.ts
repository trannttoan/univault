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
export class UnivaultError extends Error {
	constructor(
		readonly code: ErrorCode,
		options?: { cause?: unknown },
	) {
		super(code, options);
		this.name = "UnivaultError";
	}
}
