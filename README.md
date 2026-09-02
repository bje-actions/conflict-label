# conflict-label

A GitHub Action that keeps a label in sync with a pull request's merge state. When GitHub
reports the pull request as `DIRTY` the label is added; when it reports any other known state
the label is removed. The label is created on first use if the repository does not have it
yet. It ships as a committed [ncc](https://github.com/vercel/ncc) bundle, so nothing is
installed at run time and the only network dependency is the GitHub API.

It is built to live in exactly one place. An enterprise ruleset requires the workflow in this
repository on every pull request in every organization, so no repository has to carry a copy
of the action or a workflow file, and updating this repository updates the check everywhere.
The organization and repository paths below exist for accounts that cannot use enterprise
rulesets; they are fallbacks, not the intended deployment.

## Setup

Ready-to-import ruleset definitions live in [`rulesets/`](rulesets/). Each one is the JSON
shape GitHub's ruleset import accepts and the API returns, so it can be uploaded through the
UI ("Import a ruleset" on the rulesets page) or applied with the API or any provider that
speaks it. All three target the default branch, enforce actively, and declare no bypass actors.

### Across a whole enterprise, with a ruleset (recommended)

This is the deployment the action is designed for. Import
[`rulesets/enterprise-conflict-label.json`](rulesets/enterprise-conflict-label.json) at the
enterprise level (Policies > Code > Rulesets > Import a ruleset). GitHub then runs this
repository's `.github/workflows/pr-conflict-label.yml` at `refs/heads/main` as a required
check on the default branch of every repository in every organization.

Nothing is added to any repository: no workflow file, no action reference, no secrets. The
workflow is fetched from here at run time, so a change merged to `main` in this repository
takes effect on the next pull request everywhere, with no rollout to individual repositories.
Required workflows via rulesets are an Enterprise Cloud feature.

This repository is public, which matters: a required workflow file has to live in a repository
at least as visible as every repository it runs in.

### Across one organization, with a ruleset (fallback)

An organization on Enterprise Cloud that is not part of an enterprise ruleset can require the
workflow on its own, still with nothing added to individual repositories. Import
[`rulesets/org-conflict-label.json`](rulesets/org-conflict-label.json) at the organization
level. It is the same rule scoped to all repositories in that organization.

An organization on the Team plan can create organization rulesets too, but the "require
workflows" rule is Enterprise Cloud only, so the workflow cannot be injected from outside the
repository. Instead, each repository adds the caller workflow from the next section, and the
organization imports
[`rulesets/org-team-conflict-label.json`](rulesets/org-team-conflict-label.json), which
requires the status check that caller produces across the organization. A repository without
the caller workflow never reports that check and cannot merge, so either add the caller
everywhere or narrow the ruleset's `repository_name` condition to the repositories that have
it.

### In a single repository, with a caller workflow (fallback)

Repository rulesets cannot require workflows, so a single repository (on any plan) opts in with
a workflow that calls this one. This is the only path that puts a file in the repository:

```yaml
on: [pull_request_target]

jobs:
  conflict-label:
    uses: bje-actions/conflict-label/.github/workflows/pr-conflict-label.yml@main
    permissions:
      pull-requests: write
      issues: write
```

To make that check required, import
[`rulesets/repo-conflict-label.json`](rulesets/repo-conflict-label.json) at the repository
level. It requires the status check `conflict-label / Sync conflict label`, which is the name
the caller job above produces. If you rename the caller job, update the context to match.

Or use the action directly inside an existing job:

```yaml
- uses: bje-actions/conflict-label@main
  with:
    label: conflicting
```

### Permissions

The job needs `pull-requests: write` and `issues: write`. Labels on a pull request go through
the issues endpoints, and creating a missing label needs the issues scope. The workflow has to
run on `pull_request_target` rather than `pull_request` so that pull requests from forks get a
writable token; see [SECURITY.md](SECURITY.md) for why that is safe here.

### Contributing to this repository

`pnpm install` installs [lefthook](https://github.com/evilmartians/lefthook) git hooks. The
pre-commit hook runs biome on staged files and rebuilds `dist/` and stages it, so `src/` and
the committed bundle cannot drift; the pre-push hook runs typecheck and the full test suite.
CI fails on any `dist/` mismatch, which catches commits made with hooks bypassed and
Dependabot bumps to runtime dependencies. Fix either by checking out the branch, running
`pnpm build`, and committing `dist/`.

## What it does

- Reads the pull request's `mergeStateStatus` over GraphQL.
- `DIRTY` adds the label. Any other known state (`MERGEABLE`, `BLOCKED`, `BEHIND`, `CLEAN`,
  `HAS_HOOKS`, `UNSTABLE`, `DRAFT`) removes it, tolerating a 404 that says the label was not
  applied.
- GitHub computes mergeability lazily, so a fresh pull request reports `UNKNOWN`. The action
  polls with exponential backoff (1s, 2s, 4s, capped at 15s) while a further wait still fits
  inside `poll-seconds`, then leaves the label untouched and exits 0 if the state never
  settles.
- `merge_group` events exit 0 immediately.
- It is built never to fail for a reason that is not a real, fixable configuration error. The
  full failure policy is in [ARCHITECTURE.md](ARCHITECTURE.md).

### Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `label` | no | `conflicting` | Label applied while the pull request is conflicting |
| `poll-seconds` | no | `120` | How long to keep polling while GitHub reports `UNKNOWN` |
| `pr-number` | no | triggering pull request | Pull request to act on when the event payload does not carry one |
| `token` | no | `${{ github.token }}` | Token used for the API calls. Needs `pull-requests: write` and `issues: write` |

### Outputs

| Output | Values |
| --- | --- |
| `outcome` | `completed` when the label was synced, `failed-open` when an error was tolerated, `failed` when the run failed closed |

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test --coverage
pnpm build
```

`dist/` is committed and CI fails if it does not match the sources. The pre-commit hook runs
`pnpm build` and stages `dist/` for you. Dependabot cannot run the build, so a Dependabot bump
to a runtime dependency fails the dist check until someone checks out the branch, runs
`pnpm build`, and commits `dist/`. Pushing to a Dependabot branch stops Dependabot rebasing it,
so finish that pull request by hand once you touch it.

Coverage is measured with vitest and the v8 provider, reported as Cobertura, and uploaded so
the enterprise Code Coverage ruleset can read it. The threshold is 100% for lines, branches,
functions, and statements against `src/`, with only the thin `src/main.ts` entry point
excluded.

## License

MIT. See [LICENSE](LICENSE).

## Further reading

- [ADR 0001: deploy as an enterprise-required workflow](docs/adr/0001-required-workflow-deployment.md)
- [SECURITY.md](SECURITY.md): why this is safe to run on `pull_request_target`, and the rules
  that keep it that way.
- [ARCHITECTURE.md](ARCHITECTURE.md): the reliability contract, the failure policy, and why
  the ruleset references `main`.
