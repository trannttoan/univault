import type { LocalChange } from "./local-delta";
import type { RemoteChange } from "./remote-delta";

export type Outcome = "noop" | "upload" | "download" | "conflict";

// Phase 0 rules: deletions on either side are ignored, and a path changed on
// both sides to different content is a conflict (no merge yet). Without an
// anchor every file on each side arrives as "added", so the same rules apply.
export function classify(local: LocalChange | undefined, remote: RemoteChange | undefined): Outcome {
	const ours = local && local.kind !== "deleted" ? local : undefined;
	const theirs = remote && remote.kind !== "removed" ? remote : undefined;
	if (ours && theirs) return ours.blobSha === theirs.sha ? "noop" : "conflict";
	if (ours) return "upload";
	if (theirs) return "download";
	return "noop";
}

export function classifyAll(
	local: Map<string, LocalChange>,
	remote: Map<string, RemoteChange>,
): Map<string, Outcome> {
	const outcomes = new Map<string, Outcome>();
	for (const path of new Set([...local.keys(), ...remote.keys()])) {
		outcomes.set(path, classify(local.get(path), remote.get(path)));
	}
	return outcomes;
}
