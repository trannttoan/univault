import { type ErrorCode, UnivaultError } from "../errors";
import type { SyncOutcome } from "../sync/orchestrator";

const MESSAGES: Record<ErrorCode, string> = {
	offline: "You're offline.",
	"rate-limited": "GitHub's rate limit was reached. Try again later.",
	"auth-expired": "GitHub rejected the token. Enter a new one in settings.",
	forbidden: "The token can't access this repository. It needs Contents read and write.",
	"not-found": "Repository or branch not found. Check the settings, and that the token covers this repository.",
	"conflict-retry": "The repository kept changing during sync. Try again.",
	"tree-too-large": "The repository is too large to sync.",
	"path-unsafe": "The repository contains a path that can't be written safely.",
	"storage-full": "The device is out of storage.",
	unknown: "Sync failed unexpectedly.",
};

export function errorMessage(code: ErrorCode): string {
	return MESSAGES[code];
}

// A failed sign-in keeps any existing session. Codes the user cannot act on from the
// message alone carry the client's (already redacted) cause, since there is no log yet.
export function signInFailure(error: unknown, login: string | null): string {
	const code = error instanceof UnivaultError ? error.code : "unknown";
	const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
	const detail = cause && (code === "offline" || code === "unknown") ? ` (${cause})` : "";
	const kept = login ? ` Still signed in as ${login}.` : "";
	return `${errorMessage(code)}${detail}${kept}`;
}

export function outcomeMessage(outcome: SyncOutcome): string {
	switch (outcome.kind) {
		case "remote-empty":
			return "Univault: nothing to sync. The repository is empty and this vault has no files yet.";
		case "needs-setup":
			return "Univault: finish setup in settings (token, repository and branch).";
		case "failed": {
			const { code, paths } = outcome.error;
			return `Univault: ${errorMessage(code)}${paths.length ? ` Files: ${paths.join(", ")}` : ""}`;
		}
		case "synced": {
			const merged = outcome.merged?.length ?? 0;
			if (outcome.uploaded + outcome.downloaded + merged === 0) return "Univault: already in sync.";
			const merges = merged ? `, ${merged} merged` : "";
			return `Univault: synced, ${outcome.uploaded} uploaded, ${outcome.downloaded} downloaded${merges}.`;
		}
	}
}
