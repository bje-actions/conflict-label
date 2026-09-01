import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  createOctokit,
  MAX_RATE_LIMIT_RETRIES,
  MERGE_STATE_QUERY,
  type OctokitLike,
  onRateLimit,
} from '../src/github';

vi.mock('@actions/core');

const repo = { owner: 'bje-actions', repo: 'conflict-label' };

function fakeOctokit(overrides: Partial<OctokitLike> = {}): OctokitLike {
  return {
    graphql: vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeStateStatus: 'CLEAN' } } }),
    request: vi.fn().mockResolvedValue({ status: 200 }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('onRateLimit', () => {
  it('retries within the budget and warns', () => {
    expect(onRateLimit(5, { method: 'GET', url: '/rate_limit' }, null, 0)).toBe(true);
    expect(core.warning).toHaveBeenCalledOnce();
  });

  it('falls back when the request has no method or url', () => {
    expect(onRateLimit(5, {}, null, 1)).toBe(true);
  });

  it('stops once the budget is spent', () => {
    expect(onRateLimit(5, {}, null, MAX_RATE_LIMIT_RETRIES)).toBe(false);
  });
});

describe('createOctokit', () => {
  it('builds a client with the retry and throttling plugins', () => {
    const octokit = createOctokit('token');
    expect(octokit.graphql).toBeTypeOf('function');
    expect(octokit.request).toBeTypeOf('function');
  });
});

describe('createClient', () => {
  it('queries mergeStateStatus over GraphQL', async () => {
    const octokit = fakeOctokit();
    await expect(createClient(octokit, repo).mergeStateStatus(7)).resolves.toBe('CLEAN');
    expect(octokit.graphql).toHaveBeenCalledWith(MERGE_STATE_QUERY, { ...repo, number: 7 });
  });

  it.each([
    [{}],
    [{ repository: null }],
    [{ repository: { pullRequest: null } }],
    [{ repository: { pullRequest: { mergeStateStatus: null } } }],
  ])('treats a missing merge state as UNKNOWN (%o)', async (data) => {
    const octokit = fakeOctokit({ graphql: vi.fn().mockResolvedValue(data) });
    await expect(createClient(octokit, repo).mergeStateStatus(7)).resolves.toBe('UNKNOWN');
  });

  it('adds the label through the issues endpoint', async () => {
    const octokit = fakeOctokit();
    await createClient(octokit, repo).addLabel(7, 'conflicting');
    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
      { ...repo, issue_number: 7, labels: ['conflicting'] },
    );
  });

  it('removes the label', async () => {
    const octokit = fakeOctokit();
    await createClient(octokit, repo).removeLabel(7, 'conflicting');
    expect(octokit.request).toHaveBeenCalledWith(
      'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}',
      { ...repo, issue_number: 7, name: 'conflicting' },
    );
  });

  it('tolerates a 404 when the label is not applied', async () => {
    const octokit = fakeOctokit({ request: vi.fn().mockRejectedValue({ status: 404 }) });
    await expect(
      createClient(octokit, repo).removeLabel(7, 'conflicting'),
    ).resolves.toBeUndefined();
  });

  it('rethrows any other removal failure', async () => {
    const octokit = fakeOctokit({ request: vi.fn().mockRejectedValue({ status: 500 }) });
    await expect(createClient(octokit, repo).removeLabel(7, 'conflicting')).rejects.toEqual({
      status: 500,
    });
  });
});
