import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { PullRequestClient } from '../src/github';
import { backoffMs, resolveOptions, run, sleep } from '../src/run';

vi.mock('@actions/core');

interface FakeClient extends PullRequestClient {
  mergeStateStatus: Mock<(prNumber: number) => Promise<string>>;
  addLabel: Mock<(prNumber: number, label: string) => Promise<void>>;
  removeLabel: Mock<(prNumber: number, label: string) => Promise<void>>;
}

function fakeClient(states: string[]): FakeClient {
  const queue = [...states];
  return {
    mergeStateStatus: vi.fn(async () => queue.shift() ?? queue.at(-1) ?? 'UNKNOWN'),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
  };
}

/** Advances the mocked clock instead of really waiting. */
const fastSleep = async (ms: number): Promise<void> => {
  vi.advanceTimersByTime(ms);
};

const options = {
  eventName: 'pull_request_target',
  prNumber: 7,
  label: 'conflicting',
  pollSeconds: 120,
};

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
    await run(options, client, fastSleep);
    expect(client.addLabel).toHaveBeenCalledWith(7, 'conflicting');
    expect(client.removeLabel).not.toHaveBeenCalled();
  });

  it.each(['MERGEABLE', 'BLOCKED', 'BEHIND', 'CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'DRAFT'])(
    'removes the label when the pull request is %s',
    async (state) => {
      const client = fakeClient([state]);
      await run(options, client, fastSleep);
      expect(client.removeLabel).toHaveBeenCalledWith(7, 'conflicting');
      expect(client.addLabel).not.toHaveBeenCalled();
    },
  );

  it('passes when removal reports that the label was never applied', async () => {
    const client = fakeClient(['CLEAN']);
    client.removeLabel.mockResolvedValue(undefined);
    await run(options, client, fastSleep);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('polls while the state is UNKNOWN and acts once it settles', async () => {
    const client = fakeClient(['UNKNOWN', 'UNKNOWN', 'DIRTY']);
    await run(options, client, fastSleep);
    expect(client.mergeStateStatus).toHaveBeenCalledTimes(3);
    expect(client.addLabel).toHaveBeenCalledWith(7, 'conflicting');
  });

  it('touches nothing when the state is still UNKNOWN after the budget', async () => {
    const client = fakeClient(['UNKNOWN']);
    await run({ ...options, pollSeconds: 10 }, client, fastSleep);
    expect(client.addLabel).not.toHaveBeenCalled();
    expect(client.removeLabel).not.toHaveBeenCalled();
    expect(core.notice).toHaveBeenCalledOnce();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('does nothing at all when the poll budget is zero', async () => {
    const client = fakeClient(['UNKNOWN']);
    await run({ ...options, pollSeconds: 0 }, client, fastSleep);
    expect(client.mergeStateStatus).toHaveBeenCalledOnce();
    expect(client.addLabel).not.toHaveBeenCalled();
  });

  it('fails the run on an authorization error', async () => {
    const client = fakeClient(['DIRTY']);
    client.addLabel.mockRejectedValue(
      Object.assign(new Error('Resource not accessible'), { status: 403 }),
    );
    await run(options, client, fastSleep);
    expect(core.setFailed).toHaveBeenCalledOnce();
  });

  it('warns and passes on a server error', async () => {
    const client = fakeClient(['DIRTY']);
    client.mergeStateStatus.mockRejectedValue({ status: 500, message: 'server error' });
    await run(options, client, fastSleep);
    expect(core.warning).toHaveBeenCalledOnce();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('warns and passes on a network error', async () => {
    const client = fakeClient(['DIRTY']);
    client.mergeStateStatus.mockRejectedValue(new Error('ECONNRESET'));
    await run(options, client, fastSleep);
    expect(core.warning).toHaveBeenCalledOnce();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('is a no-op on merge_group events', async () => {
    const client = fakeClient(['DIRTY']);
    await run({ ...options, eventName: 'merge_group' }, client, fastSleep);
    expect(client.mergeStateStatus).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no pull request in context', async () => {
    const client = fakeClient(['DIRTY']);
    await run({ ...options, prNumber: undefined }, client, fastSleep);
    expect(client.mergeStateStatus).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
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

  it('is the default used by run', async () => {
    const client = fakeClient(['CLEAN']);
    await run(options, client);
    expect(client.removeLabel).toHaveBeenCalledOnce();
  });
});

describe('resolveOptions', () => {
  it('reads the pull request from the webhook payload', () => {
    expect(
      resolveOptions(
        { label: '', pollSeconds: '', prNumber: '' },
        { eventName: 'pull_request_target', payload: { pull_request: { number: 12 } } },
      ),
    ).toEqual({
      eventName: 'pull_request_target',
      prNumber: 12,
      label: 'conflicting',
      pollSeconds: 120,
    });
  });

  it('lets the pr-number input win', () => {
    expect(
      resolveOptions(
        { label: 'smoke-test', pollSeconds: '30', prNumber: '99' },
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
        { label: '', pollSeconds: '', prNumber: '' },
        {
          eventName: 'push',
          payload: {},
        },
      ).prNumber,
    ).toBeUndefined();
  });
});
