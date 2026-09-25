# ADR-001: Commit-anchored sync state with a local index

Status: Accepted · 2026-09-25

## Context

The plugin must know, on every sync, what changed locally and what changed remotely since the two sides last agreed, and it must be able to fetch the agreed version of any file as the base for a three-way merge. Syncs run every few seconds of editing on phones with about 45 MB of heap and against an API quota of 5,000 requests per hour. Vaults range to 50,000 files.

## Decision

Store one **sync anchor** per vault: repository, branch, and the remote commit SHA the last sync ended on. Store a **local index** with one entry per file: path, mtime, size, blob SHA.

- Remote delta: fetch the branch head with a conditional request. Unchanged head means no remote delta and no quota cost. Changed head means fetch the compare between the anchored commit and the head and use its file list. Fall back to a full tree read only when the compare is too large or there is no anchor.
- Local delta: compare the vault's stat data against the index and hash only files whose mtime or size changed.
- Merge base: the blob SHA in the index, fetched from the repository by SHA when a merge is needed.
- The anchor and index advance together, only after the remote confirms the commit.

## Consequences

- Steady-state sync cost scales with the size of the change, not the size of the vault.
- The anchor must be discarded when the repository or branch changes; the next sync then runs the first-sync flow.
- The compare endpoint caps at 300 changed files per response, so the tree-read fallback must exist and be tested.
- The index is per device and lives in IndexedDB (ADR-004).

## Alternatives rejected

- **Path-to-SHA baseline map** (every competitor): fetch the full recursive tree every sync and diff both sides against the map. Pays for the whole vault on every sync, hits the 7 MB tree ceiling sooner, and rewrites the whole map each time.
- **Local shadow copy**: keep a second copy of the last-synced content on the device so merges need no network. Doubles disk use, which attachment-heavy vaults on phones cannot afford.
