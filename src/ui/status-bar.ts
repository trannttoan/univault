import type { SyncState } from "../sync/orchestrator";

export function statusText(state: SyncState, lastSyncAt: Date | null): string {
	if (state === "syncing") return "Univault: syncing…";
	if (state === "error") return "Univault: error";
	if (!lastSyncAt) return "Univault: idle";
	return `Univault: idle · ${lastSyncAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
