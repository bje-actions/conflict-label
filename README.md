# conflict-label

A GitHub Action that keeps a label in sync with a pull request's merge state. When GitHub
reports the pull request as `DIRTY` the label is added; when it reports any other known state
the label is removed. The label is created on first use if the repository does not have it
yet. It ships as a committed [ncc](https://github.com/vercel/ncc) bundle, so nothing is
installed at run time and the only network dependency is the GitHub API.

## Setup

### Across a whole enterprise, with a ruleset

Required workflows via rulesets are an Enterprise Cloud feature. Create a branch ruleset at
the enterprise level targeting the default branch of every repository, and add a workflow rule
pointing at this repository's `.github/workflows/pr-conflict-label.yml` at `refs/heads/main`.
Repositories then get the check with no per-repository configuration.

This repository is public, which matters: a required workflow file has to live in a repository
at least as visible as every repository it runs in.

### Across one organization, with a ruleset

An organization on Enterprise Cloud can require the workflow with an organization ruleset,
without the enterprise being involved. Create a branch ruleset targeting the default branch of
the repositories you want covered, and add a "Require workflows to pass before merging" rule
pointing at this repository's `.github/workflows/pr-conflict-label.yml` at `refs/heads/main`.
This repository is public, so any organization can reference it.

Through the API, replacing `ORG`:

```bash
gh api -X POST /orgs/ORG/rulesets --input - <<'JSON'
{
  "name": "Conflict label",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] },
    "repository_name": { "include": ["~ALL"], "exclude": [] }
  },
  "rules": [{
    "type": "workflows",
    "parameters": {
      "do_not_enforce_on_create": true,
      "workflows": [{
        "repository_id": 1354009645,
        "path": ".github/workflows/pr-conflict-label.yml",
        "ref": "refs/heads/main"
      }]
    }
  }]
}
JSON
```

Or with the `integrations/github` Terraform provider:

```hcl
resource "github_organization_ruleset" "conflict_label" {
  name        = "Conflict label"
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  rules {
    required_workflows {
      do_not_enforce_on_create = true

      required_workflow {
        repository_id = 1354009645
        path          = ".github/workflows/pr-conflict-label.yml"
        ref           = "main"
      }
    }
  }
}
```

`1354009645` is this repository's id (`gh api repos/bje-actions/conflict-label --jq .id`).

### In a single repository, with a caller workflow

On a Team plan, or for a repository that wants to opt in explicitly, add a workflow that calls
this one:

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

### Permissions

The job needs `pull-requests: write` and `issues: write`. Labels on a pull request go through
the issues endpoints, and creating a missing label needs the issues scope. The workflow has to
run on `pull_request_target` rather than `pull_request` so that pull requests from forks get a
writable token; see [SECURITY.md](SECURITY.md) for why that is safe here.

### Prerequisite for contributors to this repository

`.github/workflows/rebuild-dist.yml` needs `APP_ID` and `APP_PRIVATE_KEY` configured as
**Dependabot** secrets (Settings > Secrets and variables > Dependabot), not Actions secrets,
because a Dependabot-triggered run only reads the Dependabot store. The App they identify must
be installed on this repository with contents write. Without them, Dependabot pull requests
that change a runtime dependency have to be rebuilt by hand.

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

`dist/` is committed and CI fails if it does not match the sources, so run `pnpm build` and
commit the result with any change under `src/`. Dependabot bumps to runtime dependencies are
rebuilt automatically by `.github/workflows/rebuild-dist.yml`. Pushing to a Dependabot branch
stops Dependabot rebasing it automatically, so a stale bump has to be closed and reopened.

Coverage is measured with vitest and the v8 provider, reported as Cobertura, and uploaded so
the enterprise Code Coverage ruleset can read it. The threshold is 100% for lines, branches,
functions, and statements against `src/`, with only the thin `src/main.ts` entry point
excluded.

## License

MIT. See [LICENSE](LICENSE).

## Further reading

- [SECURITY.md](SECURITY.md): why this is safe to run on `pull_request_target`, and the rules
  that keep it that way.
- [ARCHITECTURE.md](ARCHITECTURE.md): the reliability contract, the failure policy, and why
  the ruleset references `main`.
