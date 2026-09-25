# ADR-004: IndexedDB for per-device state; per-vault local storage for the session

Status: Accepted · 2026-09-25

## Context

Per-device state includes the sync anchor, a local index of up to 50,000 entries, binary pre-merge snapshots, pending conflicts, the upload queue, rename records, and the sync log. None of it may leak into the vault folder, where another sync tool or config sync could copy it to a different device. The refresh token must be stored outside the vault.

## Decision

- IndexedDB, through a thin typed wrapper with a schema version and forward-only migrations, holds all per-device sync state.
- Obsidian's per-vault local storage holds the session (host, login, access and refresh tokens, expiry, auth kind).
- The plugin settings file holds only user preferences, which are safe to copy between devices.
- The plugin refuses to run against a schema newer than it knows.

## Consequences

- Large indexes and binary snapshots are stored natively without rewriting a file on every sync.
- Nothing device-specific lives inside the vault folder.
- IndexedDB persistence inside the iOS WebView must be confirmed (spike S9); the fallback is a recovery copy of the anchor and index in the plugin folder.
- Migrating storage later means a migration for every install, which is why this is decided now.

## Alternatives rejected

- **Everything in the plugin settings file**: one JSON blob rewritten every sync, slow at 50,000 entries on mobile, binary snapshots would need base64, and the file sits inside the vault folder.
- **Hidden files inside the vault's config directory**: easy to inspect, but inside the vault, so they must be excluded from sync on every path and a second sync tool would copy them between devices.
