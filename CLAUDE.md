# Univault

GitHub-REST sync plugin for Obsidian. Architecture and decisions: docs/TRD.md, docs/adr/. Read the TRD before changing module boundaries.

## Stack
TypeScript strict, esbuild, Vitest with the in-memory GitHub fake and fake vault adapter. Prefer zero runtime dependencies; adding one needs a one-line rationale in the TRD stack section.

## Boundaries
- The merge engine and per-path classification are pure functions. No I/O in either.
- Tokens are handled only by the session module and the GitHub client. Nothing else receives one.
- Errors carry a code from the closed set in the TRD. Never branch on message text.

## Invariants
- Byte budget: transient bytes in flight stay under the platform ceiling (16 MB mobile). Concurrency is fine under the budget. Large payloads leave the heap through streams or Blob-backed bodies; a path that can only take a heap buffer is subject to the platform cap.
- Every repository path is canonicalized and validated before touching the vault. Every vault path is NFC-normalized before comparison.
- Content decides text vs binary. A known binary extension may short-circuit to binary; nothing is classified as text by extension. Bytes are stored as read, no line-ending normalization.
- The sync anchor and index advance only after the ref update succeeds.
- Deletions go through Obsidian's file manager.
- The synced branch is a plain copy of the vault plus `.univault-ignore`. Nothing else is written to the branch.
- Repository-facing formats (ignore file, hidden ref paths, commit trailers) are frozen once released. Changing one requires an ADR.

## Testing
Every guarantee in the PRD's product principles has a test before its feature ships.
