# ADR-006: GitHub App with device flow; personal access token as fallback

Status: Accepted · 2026-09-25

## Context

Creating, scoping, and pasting a personal access token is the top setup failure in every competitor's issue tracker. A classic OAuth app with the `repo` scope would grant the plugin access to every private repository the user owns. GitHub Enterprise Server instances cannot use an app registered on github.com.

## Decision

- Sign-in uses the **device flow of a GitHub App** named **Univault Sync** (slug `univault-sync`), owned by the dedicated `univault-app` organization. The app cannot be named "Univault" because GitHub App names may not match an account login the owner does not control, and the `univault` organization belongs to a third party. The codebase repository stays under the author's personal account; only the app registration lives in the organization, so an account problem on either side does not take down the other. The app is public, has no webhook, and requests only *Contents: read and write* and *Metadata: read*. The user chooses which repositories the app may access during installation.
- User tokens expire after eight hours and are refreshed silently; the refresh token is the stored credential.
- A **fine-grained personal access token** remains available for GitHub Enterprise Server and for users whose organization blocks third-party apps.
- The client ID ships in the plugin. There is no client secret.

## Consequences

- No token handling for most users, and the plugin's access is limited to the repositories they picked.
- The project must maintain an organization and an app registration; if the app is ever unavailable, the token fallback keeps users working.
- Whether an app user token can create a repository, and how a new repository joins a selected-repositories installation, is spike S2.

## Alternatives rejected

- **Classic OAuth app**: also supports device flow, but the `repo` scope grants every private repository.
- **Personal access token only**: simplest to build, same onboarding failure as every competitor.
- **Device flow only, no token fallback**: cleanest UX, but blocks Enterprise Server and organization-restricted users.
