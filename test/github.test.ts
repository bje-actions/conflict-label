import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { RequestError } from '@octokit/request-error';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  createOctokit,
  MAX_RATE_LIMIT_RETRIES,
  MERGE_STATE_QUERY,
  type OctokitLike,
  onRateLimit,
} from '../src/github';
import { ConfigurationError } from '../src/policy';

vi.mock('@actions/core');
vi.mock('@actions/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actions/github')>();
  return { ...actual, getOctokit: vi.fn(actual.getOctokit) };
});

const repo = { owner: 'bje-actions', repo: 'conflict-label' };
const request = {
  method: 'DELETE' as const,
  url: 'https://api.github.com/repos/bje-actions/conflict-label/issues/7/labels/conflicting',
  headers: {},
};

function requestError(status: number, message: string, data: unknown): RequestError {
  return new RequestError(message, status, {
    request,
    response: { status, url: request.url, headers: {}, data },
  });
}

function fakeOctokit(overrides: Partial<OctokitLike> = {}): OctokitLike {
  return {
    graphql: vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeStateStatus: 'CLEAN' } } }),
    request: vi.fn().mockResolvedValue({ status: 200, data: [{ name: 'conflicting' }] }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('onRateLimit', () => {
  it('retries within the budget and warns', () => {
    expect(onRateLimit(5, { method: 'GET', url: '/rate_limit' }, null, 0)).toBe(true);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('retrying in 5s'));
  });

  it('falls back when the request has no method or url', () => {
    expect(onRateLimit(5, {}, null, 1)).toBe(true);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('GET unknown'));
  });

  it('warns distinctly once the budget is spent', () => {
    expect(onRateLimit(5, {}, null, MAX_RATE_LIMIT_RETRIES)).toBe(false);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('giving up'));
  });
});

describe('createOctokit', () => {
  it('builds a client with the retry and throttling plugins wired in', () => {
    const octokit = createOctokit('token') as unknown as {
      retry: { retryRequest: unknown };
    };
    expect(octokit.retry.retryRequest).toBeTypeOf('function');
  });

  it('passes both throttle callbacks to getOctokit', () => {
    createOctokit('token');
    const options = vi.mocked(getOctokit).mock.calls[0]?.[1] as {
      throttle: { onRateLimit: unknown; onSecondaryRateLimit: unknown };
    };
    expect(options.throttle.onRateLimit).toBe(onRateLimit);
    expect(options.throttle.onSecondaryRateLimit).toBe(onRateLimit);
  });
});

describe('mergeStateStatus', () => {
  it('queries the merge state over GraphQL', async () => {
    const octokit = fakeOctokit();
    await expect(createClient(octokit, repo).mergeStateStatus(7)).resolves.toBe('CLEAN');
    expect(octokit.graphql).toHaveBeenCalledWith(MERGE_STATE_QUERY, { ...repo, number: 7 });
  });

  it('treats an unresolved merge state as UNKNOWN', async () => {
    const octokit = fakeOctokit({
      graphql: vi
        .fn()
        .mockResolvedValue({ repository: { pullRequest: { mergeStateStatus: null } } }),
    });
    await expect(createClient(octokit, repo).mergeStateStatus(7)).resolves.toBe('UNKNOWN');
  });

  it.each([
    ['no data at all', {}],
    ['a null repository', { repository: null }],
    ['a null pull request', { repository: { pullRequest: null } }],
  ])('fails closed on %s', async (_name, data) => {
    const octokit = fakeOctokit({ graphql: vi.fn().mockResolvedValue(data) });
    await expect(createClient(octokit, repo).mergeStateStatus(7)).rejects.toThrow(
      ConfigurationError,
    );
    await expect(createClient(octokit, repo).mergeStateStatus(7)).rejects.toThrow(
      'Pull request #7 not found in bje-actions/conflict-label.',
    );
  });
});

describe('addLabel', () => {
  it('adds the label through the issues endpoint', async () => {
    const octokit = fakeOctokit();
    await createClient(octokit, repo).addLabel(7, 'conflicting');
    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
      { ...repo, issue_number: 7, labels: ['conflicting'] },
    );
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('warns when the label is missing from the response', async () => {
    const octokit = fakeOctokit({
      request: vi.fn().mockResolvedValue({ data: [{ name: 'other' }, null, { name: 42 }] }),
    });
    await createClient(octokit, repo).addLabel(7, 'conflicting');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('[other]'));
  });

  it('warns when the response carries no label list', async () => {
    const octokit = fakeOctokit({ request: vi.fn().mockResolvedValue({ data: undefined }) });
    await createClient(octokit, repo).addLabel(7, 'conflicting');
    expect(core.warning).toHaveBeenCalledOnce();
  });
});

describe('removeLabel', () => {
  it('removes the label', async () => {
    const octokit = fakeOctokit();
    await createClient(octokit, repo).removeLabel(7, 'conflicting');
    expect(octokit.request).toHaveBeenCalledWith(
      'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}',
      { ...repo, issue_number: 7, name: 'conflicting' },
    );
  });

  it('tolerates a 404 that says the label is not applied', async () => {
    const octokit = fakeOctokit({
      request: vi
        .fn()
        .mockRejectedValue(requestError(404, 'Not Found', { message: 'Label does not exist' })),
    });
    await expect(
      createClient(octokit, repo).removeLabel(7, 'conflicting'),
    ).resolves.toBeUndefined();
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('was not on pull request #7'));
  });

  it('rethrows a 404 about anything else', async () => {
    const octokit = fakeOctokit({
      request: vi.fn().mockRejectedValue(requestError(404, 'Not Found', { message: 'Not Found' })),
    });
    await expect(createClient(octokit, repo).removeLabel(7, 'conflicting')).rejects.toThrow(
      'Not Found',
    );
  });

  it('rethrows any other removal failure', async () => {
    const octokit = fakeOctokit({
      request: vi.fn().mockRejectedValue(requestError(500, 'server error', {})),
    });
    await expect(createClient(octokit, repo).removeLabel(7, 'conflicting')).rejects.toThrow(
      'server error',
    );
  });
});
