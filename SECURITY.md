# Security

## The rule

**The action, and the `pr-conflict-label.yml` workflow that invokes it, never check out or
execute pull request content.** They read `mergeStateStatus` over GraphQL and call the issue
labels REST endpoints. Nothing else.

That is the whole reason it is safe to run on `pull_request_target`. On `pull_request`, the
`GITHUB_TOKEN` is read-only for pull requests from forks, so the label write would fail and
the required check would fail with it, blocking every fork pull request. `pull_request_target`
runs in the base repository context with a writable token, which is dangerous only when a
workflow builds or executes the pull request's code. This one does not.

Anyone changing that workflow or the action must keep the property:

- No `actions/checkout` of the pull request head.
- No build, test, or script execution of pull request code.
- No untrusted input (branch names, titles, bodies, labels) reaching a shell.

## Token permissions

The job asks for `pull-requests: write` and `issues: write`, and nothing else. Labels on a
pull request go through the issues endpoints, and creating a missing label needs the issues
scope. The enterprise default token permission is `read`, so the workflow declares both scopes
explicitly rather than relying on a repository setting.

The action fails the run on a 401, or on a 403 that is not a rate limit, precisely so that a
missing permission is visible rather than silently turning the check into a no-op.

## Trust boundary in this repository's own CI

This repository's `ci.yml` does build and test pull request code. That is fine, and is a
different trust boundary: it runs on `pull_request`, where a fork's token is read-only and no
secrets are exposed to fork pull requests. The smoke job that runs the action against the pull
request itself is skipped for forks for the same reason.

`rebuild-dist.yml` is the one workflow that both checks out a pull request head and holds a
writable App token. It is guarded three ways:

- It runs on `pull_request`, never `pull_request_target`.
- The whole job is gated on `github.actor == 'dependabot[bot]'`.
- The App token is minted with `permission-contents: write` only.

Its secrets live in the Dependabot secrets store, so an ordinary pull request cannot reach
them even if the actor guard were bypassed.

## Reporting a vulnerability

Open an issue on this repository, or contact the maintainer privately if the report should not
be public.
