# ADR-005: Hidden refs for device state, one root ignore file, commit trailers for annotations

Status: Accepted · 2026-09-25

## Context

The plugin needs a home in the repository for shared ignore rules, per-device manifests (name, platform, last sync), and per-file facts the history view needs (which commits were automatic merges, which renames happened). Anything written into a user's repository must be supported indefinitely. The synced branch must stay a plain copy of the vault, and syncs with no content changes must not create commits.

## Decision

- **Ignore rules** live in `.univault-ignore` at the vault root, versioned with the vault so every device sees changes.
- **Device manifests** live under `refs/univault/devices/<login>/<device-id>`, each pointing to a one-file tree. They never touch the synced branch or its history.
- **Annotations** are structured commit-message trailers: `Univault-Device: <login>/<device-name>`, `Univault-Merge: <path> <base> <ours> <theirs>` per auto-merged file, `Univault-Rename: <old> -> <new>` per rename. The history view reads them; nothing else is stored.
- The synced branch contains the vault plus `.univault-ignore` and nothing else.
- These formats are frozen once released. Changing one requires a new ADR.

## Consequences

- Device state updates cost one ref write and never a branch commit.
- File history can follow renames and mark merges without extra storage.
- Hidden refs are invisible on github.com and to most Git clients, which is the intent; a documented command shows them.

## Alternatives rejected

- **A `.univault/` folder on the branch** for everything: inspectable on github.com, but device manifests would create commits and appear in history, and the folder would need excluding from the user's view of the vault.
- **Git-only conventions** (`.gitignore`, `.gitattributes`, nothing else): maximum compatibility, but `.gitignore` semantics do not match what an Obsidian user means by exclude, device state has nowhere to go, and merge annotations are lost.
