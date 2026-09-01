import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { ConfigurationError, statusOf } from './policy';

/** How many times a rate limited request is retried before giving up. */
export const MAX_RATE_LIMIT_RETRIES = 3;

export interface Repo {
  owner: string;
  repo: string;
}

interface ThrottleRequestOptions {
  method?: string | undefined;
  url?: string | undefined;
}

export function onRateLimit(
  retryAfter: number,
  options: ThrottleRequestOptions,
  _octokit: unknown,
  retryCount: number,
): boolean {
  const target = `${options.method ?? 'GET'} ${options.url ?? 'unknown'}`;
  if (retryCount >= MAX_RATE_LIMIT_RETRIES) {
    core.warning(
      `Rate limited on ${target} and the budget of ${MAX_RATE_LIMIT_RETRIES} retries is spent, giving up.`,
    );
    return false;
  }
  core.warning(`Rate limited on ${target}, retrying in ${retryAfter}s.`);
  return true;
}

export function createOctokit(token: string): ReturnType<typeof getOctokit> {
  return getOctokit(
    token,
    {
      throttle: {
        onRateLimit,
        onSecondaryRateLimit: onRateLimit,
      },
    },
    retry,
    throttling,
  );
}

export const MERGE_STATE_QUERY = `
  query mergeState($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        mergeStateStatus
      }
    }
  }
`;

interface MergeStateResponse {
  repository?: {
    pullRequest?: {
      mergeStateStatus?: string | null;
    } | null;
  } | null;
}

interface LabelListResponse {
  data?: unknown;
}

export interface OctokitLike {
  graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown>;
  request: (route: string, params: Record<string, unknown>) => Promise<unknown>;
}

export interface PullRequestClient {
  mergeStateStatus(prNumber: number): Promise<string>;
  addLabel(prNumber: number, label: string): Promise<void>;
  removeLabel(prNumber: number, label: string): Promise<void>;
}

function labelNamesOf(response: unknown): string[] {
  const data = (response as LabelListResponse | undefined)?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((entry) => (entry as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string');
}

/** GitHub says exactly this when the label is not on the pull request. */
function isLabelNotApplied(error: unknown): boolean {
  const data = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data;
  return data?.message === 'Label does not exist';
}

export function createClient(octokit: OctokitLike, repo: Repo): PullRequestClient {
  const slug = `${repo.owner}/${repo.repo}`;

  return {
    async mergeStateStatus(prNumber) {
      const data = (await octokit.graphql(MERGE_STATE_QUERY, {
        owner: repo.owner,
        repo: repo.repo,
        number: prNumber,
      })) as MergeStateResponse;

      const pullRequest = data?.repository?.pullRequest;
      if (data?.repository == null || pullRequest == null) {
        // A readable token would have returned the node, so this is a wrong
        // repository, a wrong number, or a token that cannot see either.
        throw new ConfigurationError(`Pull request #${prNumber} not found in ${slug}.`);
      }

      // Only an unresolved mergeability check is genuinely UNKNOWN.
      return pullRequest.mergeStateStatus ?? 'UNKNOWN';
    },

    async addLabel(prNumber, label) {
      // GitHub creates a missing label on the fly (default colour) when it is
      // added through the issues labels endpoint, so no separate create-label
      // call is needed.
      const response = await octokit.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
        {
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          labels: [label],
        },
      );

      const names = labelNamesOf(response);
      if (!names.includes(label)) {
        core.warning(
          `Asked GitHub to add "${label}" to #${prNumber} but it reported the labels [${names.join(', ')}].`,
        );
      }
    },

    async removeLabel(prNumber, label) {
      try {
        await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          name: label,
        });
      } catch (error) {
        // 404 means the label is not on the pull request, which is the state we
        // wanted anyway. Any other 404 is about the pull request itself.
        if (statusOf(error) === 404 && isLabelNotApplied(error)) {
          core.info(`Label "${label}" was not on pull request #${prNumber}.`);
          return;
        }
        throw error;
      }
    },
  };
}
