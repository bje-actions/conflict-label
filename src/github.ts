import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { statusOf } from './policy';

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
  core.warning(
    `Rate limited on ${options.method ?? 'GET'} ${options.url ?? 'unknown'}, retrying in ${retryAfter}s.`,
  );
  return retryCount < MAX_RATE_LIMIT_RETRIES;
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

export interface OctokitLike {
  graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown>;
  request: (route: string, params: Record<string, unknown>) => Promise<unknown>;
}

export interface PullRequestClient {
  mergeStateStatus(prNumber: number): Promise<string>;
  addLabel(prNumber: number, label: string): Promise<void>;
  removeLabel(prNumber: number, label: string): Promise<void>;
}

export function createClient(octokit: OctokitLike, repo: Repo): PullRequestClient {
  return {
    async mergeStateStatus(prNumber) {
      const data = (await octokit.graphql(MERGE_STATE_QUERY, {
        owner: repo.owner,
        repo: repo.repo,
        number: prNumber,
      })) as MergeStateResponse;
      return data?.repository?.pullRequest?.mergeStateStatus ?? 'UNKNOWN';
    },

    async addLabel(prNumber, label) {
      // The issues endpoint creates the label when it does not exist yet.
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner: repo.owner,
        repo: repo.repo,
        issue_number: prNumber,
        labels: [label],
      });
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
        // The label was not applied, which is the state we wanted anyway.
        if (statusOf(error) === 404) {
          return;
        }
        throw error;
      }
    },
  };
}
