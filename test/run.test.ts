import * as core from '@actions/core';
import { RequestError } from '@octokit/request-error';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { PullRequestClient } from '../src/github';
import { ConfigurationError, InputError } from '../src/policy';
import {
  type ActionContext,
  type ActionInputs,
  backoffMs,
  parseCount,
  resolveMergeState,
  resolveOptions,
  resolveToken,
  run,
  sleep,
  syncLabel,
} from '../src/run';

vi.mock('@actions/core');

interface FakeClient extends PullRequestClient {
  mergeStateStatus: Mock<(prNumber: number) => Promise<string>>;
  addLabel: Mock<(prNumber: number, label: string) => Promise<void>>;
  removeLabel: Mock<(prNumber: number, label: string) => Promise<void>>;
}

/** Replays the given merge states, repeating the last one once exhausted. */
function fakeClient(states: string[]): FakeClient {
  const queue = [...states];
  let last = states.at(-1) ?? 'UNKNOWN';
  return {
    mergeStateStatus: vi.fn(async () => {
      last = queue.shift() ?? last;
      return last;
    }),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
  };
}

/** Advances the mocked clock instead of really waiting. */
function recordingSleep(): Mock<(ms: number) => Promise<void>> {
  return vi.fn(async (ms: number) => {
    vi.advanceTimersByTime(ms);
  });
}

const inputs: ActionInputs = {
  label: 'conflicting',
  pollSeconds: '120',
  prNumber: '',
  token: 'ghs_token',
};

const ctx: ActionContext = {
  eventName: 'pull_request_target',
  payload: { pull_request: { number: 7 } },
};

const options = {
  eventName: 'pull_request_target',
  prNumber: 7,
  label: 'conflicting',
  pollSeconds: 120,
};

function deps(client: PullRequestClient, sleepFn = recordingSleep()) {
  return { createClient: () => client, sleep: sleepFn };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('run', () => {
  it('adds the label when the pull request is DIRTY', async () => {
    const client = fakeClient(['DIRTY']);
    await run(inputs, ctx, deps(client));
    expect(client.addLabel).toHaveBeenCalledWith(7, 'conflicting');
    expect(client.removeLabel).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('outcome', 'completed');
  });

  it.each(['MERGEABLE', 'BLOCKED', 'BEHIND', 'CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'DRAFT'])(
    'removes the label when the pull request is %s',
    async (state) => {
      const client = fakeClient([state]);
      await run(inputs, ctx, deps(client));
      expect(client.removeLabel).toHaveBeenCalledWith(7, 'conflicting');
      expect(client.addLabel).not.toHaveBeenCalled();
      expect(core.setOutput).toHaveBeenCalledWith('outcome', 'completed');
    },
  );

  it('passes when the label was never applied in the first place', async () => {
    const client = fakeClient(['CLEAN']);
    // The client swallows this 404 itself, so run() sees a clean removal.
    client.removeLabel.mockImplementation(async () => {
      const error = new RequestError('Not Found', 404, {
        request: { method: 'DELETE', url: 'https://api.github.com/x', headers: {} },
        response: {
          status: 404,
          url: 'https://api.github.com/x',
          headers: {},
          data: { message: 'Label does not exist' },
        },
      });
      if (error.status !== 404) {
        throw error;
      }
    });
    await run(inputs, ctx, deps(client));
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('outcome', 'completed');
  });

  it('polls while the state is UNKNOWN and acts once it settles', async () => {
    const client = fakeClient(['UNKNOWN', 'UNKNOWN', 'DIRTY']);
    await run(inputs, ctx, deps(client));
    expect(client.mergeStateStatus).toHaveBeenCalledTimes(3);
    expect(client.addLabel).toHaveBeenCalledWith(7, 'conflicting');
  });

  it('touches nothing when the state is still UNKNOWN after the budget', async () => {
    const client = fakeClient(['UNKNOWN']);
    await run({ ...inputs, pollSeconds: '10' }, ctx, deps(client));
    expect(client.addLabel).not.toHaveBeenCalled();
    expect(client.removeLabel).not.toHaveBeenCalled();
    expect(core.notice).toHaveBeenCalledOnce();
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('outcome', 'completed');
  });

  it('does not poll at all when the budget is zero', async () => {
    const client = fakeClient(['UNKNOWN']);
    const sleepFn = recordingSleep();
    await run({ ...inputs, pollSeconds: '0' }, ctx, deps(client, sleepFn));
    expect(client.mergeStateStatus).toHaveBeenCalledOnce();
    expect(sleepFn).not.toHaveBeenCalled();
    expect(client.addLabel).not.toHaveBeenCalled();
    expect(client.removeLabel).not.toHaveBeenCalled();
    expect(core.notice).toHaveBeenCalledOnce();
  });

  it('is a no-op on merge_group events', async () => {
    const client = fakeClient(['DIRTY']);
    await run(inputs, { ...ctx, eventName: 'merge_group' }, deps(client));
    expect(client.mergeStateStatus).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('outcome', 'completed');
  });

  it('is a no-op when there is no pull request in context', async () => {
    const client = fakeClient(['DIRTY']);
    await run(inputs, { eventName: 'push', payload: {} }, deps(client));
    expect(client.mergeStateStatus).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('uses the real sleep when none is injected', async () => {
    const client = fakeClient(['UNKNOWN', 'CLEAN']);
    const pending = run(inputs, ctx, { createClient: () => client });
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(client.mergeStateStatus).toHaveBeenCalledTimes(2);
    expect(client.removeLabel).toHaveBeenCalledWith(7, 'conflicting');
  });
});

describe('run error policy', () => {
  it('fails the run on an authorization error', async () => {
    const client = fakeClient(['DIRTY']);
    client.addLabel.mockRejectedValue(
      new RequestError('Resource not accessible by integration', 403, {
        request: { method: 'POST', url: 'https://api.github.com/x', headers: {} },
        response: { status: 403, url: 'https://api.github.com/x', headers: {}, data: {} },
      }),
    );
    await run(inputs, ctx, deps(client));
    expect(core.setFailed).toHaveBeenCalledOnce();
    expect(vi.mocked(core.setFailed).mock.calls[0]?.[0]).toContain('status 403');
    expect(core.setOutput).toHaveBeenCalledWith('outcome', 'failed');
  });

  it('fails the run when the pull request cannot be seen', async () => {
    const client = fakeClient(['DIRTY']);
    client.mergeStateStatus.mockRejectedValue(new ConfigurationError('Pull request #7 not found'));
    await run(inputs, ctx, deps(client));
    expect(core.setFailed).toHaveBeenCalledOnce();
  });

  it('fails the run on a GraphQL permission error', async () => {
    const client = fakeClient(['DIRTY']);
    client.mergeStateStatus.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'needs pull-requests: read' }],
      }),
    );
    await run(inputs, ctx, deps(client));
    expect(core.setFailed).toHaveBeenCalledOnce();
    expect(vi.mocked(core.setFailed).mock.calls[0]?.[0]).toContain('pull-requests: write');
  });

  it('warns and passes on a server error', async () => {
    const client = fakeClient(['DIRTY']);
    client.mergeStateStatus.mockRejectedValue({ status: 500, message: 'server error' });
    await run(inputs, ctx, deps(client));
    expect(core.warning).toHaveBeenCalledOnce();
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('outcome', 'failed-open');
  });

  it('warns and passes on a network error', async () => {
    const client = fakeClient(['DIRTY']);
    client.mergeStateStatus.mockRejectedValue(new Error('ECONNRESET'));
    await run(inputs, ctx, deps(client));
    expect(core.warning).toHaveBeenCalledOnce();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it.each(['2m', '-1', 'NaN', 'twelve', '1.5'])(
    'fails the run on the poll-seconds input %s',
    async (pollSeconds) => {
      const client = fakeClient(['DIRTY']);
      await run({ ...inputs, pollSeconds }, ctx, deps(client));
      expect(core.setFailed).toHaveBeenCalledOnce();
      expect(client.mergeStateStatus).not.toHaveBeenCalled();
    },
  );

  it.each(['seven', '-7', '7.5'])('fails the run on the pr-number input %s', async (prNumber) => {
    const client = fakeClient(['DIRTY']);
    await run({ ...inputs, prNumber }, ctx, deps(client));
    expect(core.setFailed).toHaveBeenCalledOnce();
    expect(client.mergeStateStatus).not.toHaveBeenCalled();
  });

  it('fails the run when the token input is empty', async () => {
    const client = fakeClient(['DIRTY']);
    await run({ ...inputs, token: '  ' }, ctx, deps(client));
    expect(core.setFailed).toHaveBeenCalledOnce();
    expect(vi.mocked(core.setFailed).mock.calls[0]?.[0]).toContain('token');
  });
});

describe('resolveMergeState backoff', () => {
  it.each([
    [10, [1000, 2000, 4000], 4],
    [7, [1000, 2000, 4000], 4],
    [1, [1000], 2],
  ])('spends a %is budget as %o', async (pollSeconds, waits, polls) => {
    const client = fakeClient(['UNKNOWN']);
    const sleepFn = recordingSleep();
    await expect(resolveMergeState(client, 7, pollSeconds, sleepFn)).resolves.toBe('UNKNOWN');
    expect(sleepFn.mock.calls.map(([ms]) => ms)).toEqual(waits);
    expect(client.mergeStateStatus).toHaveBeenCalledTimes(polls);
  });

  it('caps the wait at 15s over a long budget', async () => {
    const client = fakeClient([
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
      'CLEAN',
    ]);
    const sleepFn = recordingSleep();
    await expect(resolveMergeState(client, 7, 600, sleepFn)).resolves.toBe('CLEAN');
    expect(sleepFn.mock.calls.map(([ms]) => ms)).toEqual([
      1000, 2000, 4000, 8000, 15_000, 15_000, 15_000, 15_000,
    ]);
  });

  it('refuses a budget that is not a finite number of seconds', async () => {
    const client = fakeClient(['UNKNOWN']);
    await expect(
      resolveMergeState(client, 7, Number.POSITIVE_INFINITY, recordingSleep()),
    ).rejects.toThrow(InputError);
  });
});

describe('syncLabel', () => {
  it('throws so the caller can apply the error policy', async () => {
    const client = fakeClient(['DIRTY']);
    client.addLabel.mockRejectedValue(new Error('boom'));
    await expect(syncLabel(options, client, recordingSleep())).rejects.toThrow('boom');
  });
});

describe('backoffMs', () => {
  it('grows exponentially and caps', () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(10)).toBe(15_000);
  });
});

describe('sleep', () => {
  it('resolves after the given delay', async () => {
    const settled = vi.fn();
    const pending = sleep(50).then(settled);
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(settled).toHaveBeenCalledOnce();
  });
});

describe('parseCount', () => {
  it('accepts a whole number', () => {
    expect(parseCount(' 12 ', 'poll-seconds')).toBe(12);
  });

  it('names the offending input', () => {
    expect(() => parseCount('2m', 'poll-seconds')).toThrow(/poll-seconds/);
  });
});

describe('resolveToken', () => {
  it('returns the trimmed token', () => {
    expect(resolveToken(' ghs_x ')).toBe('ghs_x');
  });

  it('rejects an empty token', () => {
    expect(() => resolveToken('')).toThrow(InputError);
  });
});

describe('resolveOptions', () => {
  it('reads the pull request from the webhook payload and applies defaults', () => {
    expect(resolveOptions({ label: '', pollSeconds: '', prNumber: '', token: 't' }, ctx)).toEqual({
      eventName: 'pull_request_target',
      prNumber: 7,
      label: 'conflicting',
      pollSeconds: 120,
    });
  });

  it('lets the pr-number input win', () => {
    expect(
      resolveOptions(
        { label: 'smoke-test', pollSeconds: '30', prNumber: '99', token: 't' },
        { eventName: 'workflow_dispatch', payload: { pull_request: { number: 12 } } },
      ),
    ).toEqual({
      eventName: 'workflow_dispatch',
      prNumber: 99,
      label: 'smoke-test',
      pollSeconds: 30,
    });
  });

  it('leaves the pull request undefined when there is no context and no input', () => {
    expect(
      resolveOptions(
        { label: '', pollSeconds: '', prNumber: '', token: 't' },
        {
          eventName: 'push',
          payload: {},
        },
      ).prNumber,
    ).toBeUndefined();
  });
});
