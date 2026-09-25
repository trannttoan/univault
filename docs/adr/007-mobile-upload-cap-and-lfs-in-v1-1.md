# ADR-007: Git Data blobs with a 20 MB mobile upload cap in v1.0; Git LFS in v1.1

Status: Accepted · 2026-09-25

## Context

Downloads can stream from GitHub's raw blob endpoint into chunked appends, so download memory is bounded regardless of file size. Uploads through the Git Data API must send the whole file as a base64 string in one JSON body, about 1.4 times the file in a single heap allocation, which a phone with about 45 MB of heap cannot do for large attachments. Large files originate on phones. GitHub's LFS free tier is now 10 GB of storage and 10 GB of bandwidth per month, and LFS uploads are raw bytes to a signed URL.

## Decision

- v1.0 uploads through the Git Data blob endpoint with a **20 MB cap on mobile** and the 100 MB blob limit on desktop. Files over the mobile cap are queued as *waiting for desktop* and uploaded by the next desktop sync.
- The transfer layer exposes a `LargeObjectStore` interface with the Git blob store as its only v1.0 implementation.
- **v1.1 adds Git LFS** as the second implementation for attachments above a size threshold. Spike S3 decides whether Blob-backed or streaming request bodies let LFS uploads bypass the heap entirely, which would remove the mobile cap.

## Consequences

- v1.0 ships with a known limitation that is visible and recoverable rather than a crash.
- The sync algorithm never changes when LFS arrives; only the store behind the interface does.
- LFS introduces pointer files and `.gitattributes`, so once a repository uses it, other Git clients need LFS installed to see real attachments.

## Alternatives rejected

- **LFS in v1.0**: adds a second transfer protocol, pointer management, and a storage-budget UI to an already large first release.
- **A hard 25 MB cap on every platform** (competitor practice): simplest, but excludes videos and PDFs that users expect to sync and that desktop can handle.
