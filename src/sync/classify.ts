import type { IndexEntry } from "../store/db";
import type { LocalChange } from "./local-delta";
import type { RemoteChange } from "./remote-delta";

export type Outcome = "noop" | "upload" | "download" | "merge" | "conflict";

// Deletions on either side are ignored until deletions sync. A path changed on both sides to different content
// merges against its index entry, the base both sides agreed on; with no entry there is no base.
// Without an anchor every file on each side arrives as "added", so the same rules apply.
export function classify(local: LocalChange | undefined, remote: RemoteChange | undefined, entry?: IndexEntry): Outcome {
	const ours = local && local.kind !== "deleted" ? local : undefined;
	const theirs = remote && remote.kind !== "removed" && remote.sha !== entry?.blobSha ? remote : undefined;
	if (ours && theirs) return ours.blobSha === theirs.sha ? "noop" : entry ? "merge" : "conflict";
	if (ours) return "upload";
	if (theirs) return "download";
	return "noop";
}

export function classifyAll(
	local: Map<string, LocalChange>,
	remote: Map<string, RemoteChange>,
	index: Map<string, IndexEntry> = new Map(),
): Map<string, Outcome> {
	const outcomes = new Map<string, Outcome>();
	for (const path of new Set([...local.keys(), ...remote.keys()])) {
		outcomes.set(path, classify(local.get(path), remote.get(path), index.get(path)));
	}
	return outcomes;
}
