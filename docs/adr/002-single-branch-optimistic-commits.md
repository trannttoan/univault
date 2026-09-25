# ADR-002: Single branch with optimistic conditional commits

Status: Accepted · 2026-09-25

## Context

Several devices write to one repository. The repository should remain a plain, readable copy of the vault on github.com and in any Git client. Concurrent writes from two devices must never lose either side.

## Decision

Every device commits directly to the one synced branch. Each sync builds one commit whose parent is the anchored commit and updates the branch ref conditionally on that parent. If the update is rejected because another device moved the branch, the plugin pulls the new head, re-runs classification and merge locally, and retries, at most three times per trigger. The plugin never force-updates the ref.

## Consequences

- One linear history, readable anywhere, no branch clutter.
- Conflicts are always resolved on the device that detects them, which is where the merge engine and the user are.
- Under heavy concurrent editing from many devices, retries can chain; the three-retry limit turns that into a visible error rather than a spin.

## Alternatives rejected

- **Per-device branches merged server-side** through GitHub's merge endpoint. Leaves a branch per device in the repository, produces merge commits the user did not author, and gives no control over text-merge behavior, so overlap handling would be worse than doing it locally.
- **Append-only event log** reconstructed into a vault. Maximizes history fidelity but the repository stops being a plain copy of the vault, which breaks viewing on github.com and every other Git client.
