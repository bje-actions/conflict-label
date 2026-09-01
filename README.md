# conflict-label

A GitHub Action that keeps a label in sync with a pull request's merge state. When GitHub
reports the pull request as `DIRTY` the label is added; when it reports any other known
state the label is removed. The label is created on first use if the repository does not
have it yet.

It ships as a committed [ncc](https://github.com/vercel/ncc) bundle, so nothing is installed
at run time and the only network dependency is the GitHub API.

## Security rule

**The action, and the `pr-conflict-label.yml` workflow that invokes it, never check out or
execute pull request content.** They read `mergeStateStatus` over GraphQL and call the issue
labels REST endpoints. Nothing else.

That is the whole reason it is safe to run on `pull_request_target`, which is required so
that pull requests from forks get a writable token. Anyone changing that workflow or the
action must keep the property: no `actions/checkout` of the pull request head, no build or
test of pull request code, no untrusted input reaching a shell.

This repository's own CI does build and test pull request code, which is fine because it runs
on `pull_request` with a read-only token and no access to secrets from forks.

## Reliability contract

The workflow is deployed as an enterprise required workflow with no bypass actors, so its
conclusion gates every merge. It must never fail for a reason that is not a real, fixable
configuration error.

| Situation | Behaviour |
| --- | --- |
| Merge state is `DIRTY` | Add the label, exit 0 |
| Merge state is any other known value | Remove the label, exit 0. A 404 saying the label is not applied counts as success |
| Merge state is `UNKNOWN` | Poll with exponential backoff (1s, 2s, 4s, capped at 15s) while a further wait still fits inside `poll-seconds` |
| Still `UNKNOWN` after the budget | Touch nothing, log a notice, exit 0. Not knowing is not a failure |
| `merge_group` event | Exit 0 immediately |
| 429, 5xx, secondary rate limit, network error | Retried by the Octokit retry and throttling plugins; if it still fails, log a warning and exit 0 |
| 403 that is a rate limit | Transient, so warning and exit 0, even though a plain 403 fails the run |
| 401, or a 403 that is not a rate limit | `core.setFailed`. The token or the `permissions:` block is wrong, and hiding it would make the workflow silently useless |
| GraphQL `FORBIDDEN`, `INSUFFICIENT_SCOPES`, or `NOT_FOUND` | `core.setFailed`. These arrive as HTTP 200 with an `errors` array, so they would otherwise be invisible |
| Any other GraphQL error, or a malformed response | Warning and exit 0 |
| Malformed `poll-seconds`, `pr-number`, or an empty `token` | `core.setFailed`. A bad input is a workflow bug, not an outage |

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `label` | no | `conflicting` | Label applied while the pull request is conflicting |
| `poll-seconds` | no | `120` | How long to keep polling while GitHub reports `UNKNOWN` |
| `pr-number` | no | triggering pull request | Pull request to act on when the event payload does not carry one |
| `token` | no | `${{ github.token }}` | Token used for the API calls. Needs `pull-requests: write` and `issues: write` |

## Outputs

| Output | Values |
| --- | --- |
| `outcome` | `completed` when the label was synced, `failed-open` when an error was tolerated, `failed` when the run failed closed |

## Deployment in the bje enterprise

An enterprise ruleset targeting the default branch of every repository requires this
repository's `.github/workflows/pr-conflict-label.yml` at `refs/heads/main`. Repositories in
the enterprise therefore get the check with no per-repository configuration. Because the
ruleset points at `main`, a bad merge here reaches every repository immediately, which is why
this repository runs its own typecheck, lint, 95% coverage gate, dist-matches-source check,
and a live smoke test of the pull request's own build on every pull request opened from this
repository (fork pull requests get a read-only token, so the smoke test is skipped there).

Ruleset workflows only run on `pull_request`, `pull_request_target`, and `merge_group`, and
they ignore any `types:` filters, so the workflow declares the events it needs and skips the
`merge_group` run. See
[Require workflows to pass before merging](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass-before-merging).

## Opting in without an enterprise ruleset

Required workflows via rulesets are an Enterprise Cloud feature. On a Team plan, or for a
repository that wants to opt in explicitly, call the workflow:

```yaml
on: [pull_request_target]

jobs:
  conflict-label:
    uses: bje-actions/conflict-label/.github/workflows/pr-conflict-label.yml@main
    permissions:
      pull-requests: write
      issues: write
```

Or use the action directly inside an existing job:

```yaml
- uses: bje-actions/conflict-label@main
  with:
    label: conflicting
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test --coverage
pnpm build
```

`dist/` is committed and CI fails if it does not match the sources, so run `pnpm build` and
commit the result with any change under `src/`. Dependabot bumps to runtime dependencies are
rebuilt automatically by `.github/workflows/rebuild-dist.yml`. That workflow needs `APP_ID`
and `APP_PRIVATE_KEY` configured as **Dependabot** secrets, not Actions secrets, because a
Dependabot-triggered run only reads the Dependabot store. Note that pushing to a Dependabot
branch stops Dependabot rebasing it automatically, so a stale bump has to be closed and
reopened rather than rebased.

Coverage is measured with vitest and the v8 provider, reported as Cobertura, and uploaded so
the enterprise Code Coverage ruleset can read it. The threshold is 95% for lines, branches,
functions, and statements against `src/`, with only the thin `src/main.ts` entry point
excluded.

## License

MIT. See [LICENSE](LICENSE).
