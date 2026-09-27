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
- Refresh tokens rotate, so the session module stores the new access and refresh token in one write before releasing the old pair. A crash between the refresh response and that write leaves no valid credential and forces a new sign-in.
- The refresh endpoint reports a consumed refresh token as `incorrect_client_credentials`; the client maps that error to `auth-expired` rather than treating it as a broken client ID.
- The session stores the refresh token's expiry so the UI can warn before a device that has not synced in six months has to sign in again.
- Whether an app user token can create a repository, and how a new repository joins a selected-repositories installation, is spike S2.

## Verified behavior (2026-09-26)

Measured with curl against the live registration. No client secret exists and none was used.

- `GET /apps/univault-sync` returns owner `univault-app`, client ID `Iv23liZmqSUyZ5EhTO5P`, permissions `contents: write` and `metadata: read`, and no webhook events.
- Device flow: `POST https://github.com/login/device/code` with only `client_id` returns a user code valid for 899 s, a 5 s poll interval, and `verification_uri` `https://github.com/login/device`. Polling `POST https://github.com/login/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` returns `{ access_token, expires_in: 28800, refresh_token, refresh_token_expires_in: 15638400, scope: "", token_type: "bearer" }`. Access tokens start with `ghu_`, refresh tokens with `ghr_`. `scope` is empty because GitHub Apps use installation permissions instead.
- Refresh without a client secret works: `grant_type=refresh_token` with only `client_id` and `refresh_token` returns a new pair with the same lifetimes (8 h access, 181 days refresh).
- Refresh tokens rotate: the previous refresh token is rejected immediately after a successful refresh.
- The rejected refresh token fails with `{"error":"incorrect_client_credentials"}`, not the documented `bad_refresh_token`. By error code alone, a dead refresh token and a wrong client ID look the same.
- Naming: a GitHub App name may not equal an existing account login unless the owner controls that account. The `univault` login belongs to an unrelated organization (created 2021, no public repositories), which is why the app is "Univault Sync". The `univault-sync` login was unregistered on this date. The slug derives from the name; renaming the app changes the slug and every `github.com/apps/<slug>` install URL shipped in the plugin.

## Alternatives rejected

- **Classic OAuth app**: also supports device flow, but the `repo` scope grants every private repository.
- **Personal access token only**: simplest to build, same onboarding failure as every competitor.
- **Device flow only, no token fallback**: cleanest UX, but blocks Enterprise Server and organization-restricted users.
