import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyErrorPolicy, isConfigurationError, messageOf, statusOf } from '../src/policy';

vi.mock('@actions/core');

describe('statusOf', () => {
  it('reads a numeric status', () => {
    expect(statusOf({ status: 403 })).toBe(403);
  });

  it('ignores values that carry no status', () => {
    expect(statusOf('boom')).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
    expect(statusOf({})).toBeUndefined();
    expect(statusOf({ status: '403' })).toBeUndefined();
  });
});

describe('messageOf', () => {
  it('prefers the Error message', () => {
    expect(messageOf(new Error('nope'))).toBe('nope');
  });

  it('stringifies anything else', () => {
    expect(messageOf('nope')).toBe('nope');
  });
});

describe('applyErrorPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([401, 403])('fails the run on %i', (status) => {
    expect(isConfigurationError({ status })).toBe(true);
    applyErrorPolicy(Object.assign(new Error('bad credentials'), { status }));
    expect(core.setFailed).toHaveBeenCalledOnce();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([404, 429, 500, undefined])('warns and passes on %s', (status) => {
    const error = status === undefined ? new Error('socket hang up') : { status, message: 'oops' };
    expect(isConfigurationError(error)).toBe(false);
    applyErrorPolicy(error);
    expect(core.warning).toHaveBeenCalledOnce();
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});
