# ADR 0001: Deploy the conflict label as an enterprise-required workflow

Date: 2026-09-01. Status: accepted.

## Context

The action keeps a `conflicting` label in sync with a pull request's
`mergeStateStatus`. The goal was to run it on every pull request in every
organization of the `bje` GitHub enterprise without copying a workflow file into
each repository. Issue #1 asked for a spike on whether that is possible at the
enterprise level, at the organization level, or only per repository, and on
what each path requires.

## Decision

Deploy it as a required workflow attached to one enterprise ruleset, sourced
from this public repository at `refs/heads/main`.

- The `bje` enterprise is on Enterprise Cloud, where rulesets can require a
  workflow at the organization or enterprise level. The ruleset
  `Conflict label` (id 22057296) is active with no bypass actors and targets
  the default branch of every repository in every organization.
- The workflow file must live in a repository at least as visible as every
  repository it runs in. Seven of the enterprise's repositories are public, so
  the source repository is public. It is a dedicated repository rather than the
  internal `bje-settings/github` settings repository for that reason.
- The workflow runs on `pull_request_target` so pull requests from forks get a
  writable token. It never checks out pull request content. See SECURITY.md.
- The check gates every merge and there is no bypass, so the action fails
  closed only on deterministic configuration errors (401, 403 that is not a
  rate limit, GraphQL FORBIDDEN, INSUFFICIENT_SCOPES, or NOT_FOUND, and invalid
  inputs) and fails open with a warning on everything else. See
  ARCHITECTURE.md.
- The enterprise ruleset is created from the committed
  `rulesets/enterprise-conflict-label.json`. It is not managed in Terraform;
  the `integrations/github` provider has no enterprise ruleset resource.

## Alternatives considered

- Organization rulesets in each org. They work on Enterprise Cloud and are
  manageable in Terraform, but mean one ruleset per org to keep aligned.
  `rulesets/org-conflict-label.json` is kept for organizations outside an
  enterprise ruleset.
- A caller workflow in every repository. Required on the Team plan, where the
  required-workflows rule does not exist, and for repositories on any plan
  that opt in. `rulesets/org-team-conflict-label.json` and
  `rulesets/repo-conflict-label.json` require the check that caller produces.
- A shell implementation. Rejected in favour of TypeScript because the
  enterprise Code Coverage ruleset requires a 95% report and vitest measures
  branches natively, and because Octokit's retry and throttling plugins give
  the reliability contract without hand-rolled logic.

## Validation

Performed on 2026-09-01 after the ruleset was created:

- Public repository in another organization (arsenalamerica/app pull requests
  380 and 381): the check ran on `ubuntu-slim`, read the state, tolerated a
  404 on label removal, and passed.
- Private repository (bje-actions/conflict-label-sandbox): the check ran on
  both pull requests.
- Conflict lifecycle in the same sandbox: after a colliding pull request
  merged, a push to the other one produced DIRTY and the label was added with
  the check still passing; resolving the conflict and pushing again produced
  CLEAN and the label was removed.
- The rule reaches repositories in every org: the branch rules endpoint on
  bork-ltd, arsenalamerica, bje-co, and bje-settings repositories all report
  the workflow.

Pull requests that were open before the ruleset existed do not get the check
until they receive a push or are closed and reopened.

## Consequences

- Every pull request in the enterprise now runs this workflow. A defect merged
  to `main` here affects merging everywhere, which is why CI runs typecheck,
  lint, tests at 100% coverage, a dist-matches-source check, and a live smoke
  run of the pull request's own build before merge.
- `dist/` is committed and must be rebuilt when runtime dependencies change.
  `rebuild-dist.yml` does that for Dependabot pull requests once `APP_ID` and
  `APP_PRIVATE_KEY` exist as Dependabot secrets.
- The base-branch-triggered sweep, including auto-rebase, is a separate
  action tracked in bje-settings/github#2 and is not part of this deployment.
