import type { ErrorCode } from "../errors";
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

export function outcomeMessage(outcome: SyncOutcome): string {
	switch (outcome.kind) {
		case "needs-setup":
			return "Univault: finish setup in settings (token, repository and branch).";
		case "failed":
			return `Univault: ${errorMessage(outcome.error.code)}`;
		case "synced":
			return outcome.uploaded + outcome.downloaded === 0
				? "Univault: already in sync."
				: `Univault: synced, ${outcome.uploaded} uploaded, ${outcome.downloaded} downloaded.`;
	}
}
