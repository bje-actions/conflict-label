# Architecture

## Why the contract matters

The `pr-conflict-label.yml` workflow is deployed as an enterprise required workflow with no
bypass actors, so its conclusion gates every merge across the enterprise. The action therefore
has one job beyond labelling: never fail for a reason that is not a real, fixable
configuration error.

## Failure policy

| Situation | Behaviour |
| --- | --- |
| Merge state is `DIRTY` | Add the label, exit 0 |
| Merge state is any other known value | Remove the label, exit 0. A 404 saying the label is not applied counts as success |
| Merge state is `UNKNOWN` | Poll with exponential backoff while a further wait still fits inside `poll-seconds` |
| Still `UNKNOWN` after the budget | Touch nothing, log a notice, exit 0. Not knowing is not a failure |
| `merge_group` event | Exit 0 immediately |
| 429, 5xx, secondary rate limit, network error | Retried by the Octokit retry and throttling plugins; if it still fails, log a warning and exit 0 |
| 403 that is a rate limit | Transient, so warning and exit 0, even though a plain 403 fails the run |
| 401, or a 403 that is not a rate limit | `core.setFailed`. The token or the `permissions:` block is wrong, and hiding it would make the workflow silently useless |
| GraphQL `FORBIDDEN`, `INSUFFICIENT_SCOPES`, or `NOT_FOUND` | `core.setFailed`. These arrive as HTTP 200 with an `errors` array and no status, so they would otherwise be invisible |
| Any other GraphQL error, or a malformed response | Warning and exit 0 |
| Malformed `poll-seconds` or `pr-number`, or an empty `token` | `core.setFailed`. A bad input is a workflow bug, not an outage |

A run that does fail can be recovered with a re-run from the Actions tab, which required
workflows support.

## Polling

GitHub computes mergeability lazily, so a pull request that was just pushed reports `UNKNOWN`
until a background job finishes. The action waits 1s, 2s, 4s, 8s, then 15s repeatedly, and
only sleeps when the wait still fits inside the remaining `poll-seconds` budget. A budget of
zero therefore makes exactly one query and never sleeps.

## Layout

| File | Role |
| --- | --- |
| `src/main.ts` | Entry point. Reads inputs, builds the client, calls `run`. Excluded from coverage, so it stays a few lines |
| `src/run.ts` | Input parsing, the poll loop, and the label decision |
| `src/github.ts` | Octokit factory with the retry and throttling plugins, plus the three API calls |
| `src/policy.ts` | Error classification: what fails closed, what fails open, and how errors are described |
| `dist/index.js` | Committed ncc bundle. Nothing is installed at run time |

## The outcome output

The action sets an `outcome` output: `completed` when the label was synced, `failed-open` when
an error was tolerated, `failed` when the run failed closed. The smoke job in this repository's
CI asserts `completed`, so a regression that silently starts failing open still fails the
build.

## Why the ruleset references main

The enterprise ruleset points at `.github/workflows/pr-conflict-label.yml` at
`refs/heads/main`, so a bad merge to `main` reaches every repository in the enterprise
instantly. A release tag would allow staged rollouts, but each release would then need a
ruleset edit in the enterprise UI, because the Terraform provider has no enterprise ruleset
resource.

`main` plus gates is the choice instead. Every pull request here runs typecheck, lint, the
test suite at 100% coverage, a check that `dist/` matches the sources, and a live smoke test
of the pull request's own build against the pull request itself. The required workflow also
runs on each pull request, but it runs `main`'s copy, which is why the smoke test is not
redundant.

## Ruleset event behaviour

Ruleset workflows fire only on `pull_request`, `pull_request_target`, and `merge_group`, and
every filter under those events is ignored: they always run on the default activity types
`opened`, `synchronize`, and `reopened`. The workflow is written to suit that, declaring the
events it needs and skipping the `merge_group` run. Required workflows also do not run on pull
requests that already existed when the rule was created, so those need a push or a
close-and-reopen. See
[Require workflows to pass before merging](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass-before-merging).
