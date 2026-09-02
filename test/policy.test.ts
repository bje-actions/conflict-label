import * as core from '@actions/core';
import { RequestError } from '@octokit/request-error';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyErrorPolicy,
  ConfigurationError,
  describeError,
  graphqlErrorsOf,
  InputError,
  isConfigurationError,
  isRateLimited,
  messageOf,
  statusOf,
} from '../src/policy';

vi.mock('@actions/core');

const request = {
  method: 'GET' as const,
  url: 'https://api.github.com/repos/o/r/pulls/7',
  headers: {},
};

function requestError(
  status: number,
  message: string,
  response?: { headers?: Record<string, string>; data?: unknown },
): RequestError {
  return new RequestError(message, status, {
    request,
    response: {
      status,
      url: request.url,
      headers: response?.headers ?? {},
      data: response?.data ?? {},
    },
  });
}

/** A GraphQL failure is an HTTP 200 carrying an errors array. */
function graphqlError(type: string, message = 'nope'): Error & { errors: unknown[] } {
  return Object.assign(new Error(`Request failed: ${message}`), {
    errors: [{ type, message, path: ['repository'] }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('statusOf', () => {
  it('reads the status off the error', () => {
    expect(statusOf({ status: 403 })).toBe(403);
    expect(statusOf(requestError(404, 'Not Found'))).toBe(404);
  });

  it('falls back to the response status', () => {
    expect(statusOf({ response: { status: 500 } })).toBe(500);
  });

  it('ignores values that carry no status', () => {
    expect(statusOf('boom')).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
    expect(statusOf({})).toBeUndefined();
    expect(statusOf({ status: '403' })).toBeUndefined();
    expect(statusOf({ response: { status: '500' } })).toBeUndefined();
  });
});

describe('messageOf', () => {
  it('prefers the Error message', () => {
    expect(messageOf(new Error('nope'))).toBe('nope');
  });

  it('reads a message property off a plain object', () => {
    expect(messageOf({ message: 'plain' })).toBe('plain');
  });

  it('serialises an object that has no message', () => {
    expect(messageOf({ status: 500 })).toBe('{"status":500}');
  });

  it('stringifies anything else', () => {
    expect(messageOf('nope')).toBe('nope');
    expect(messageOf(undefined)).toBe('undefined');
  });
});

describe('graphqlErrorsOf', () => {
  it('reads the errors array', () => {
    expect(graphqlErrorsOf(graphqlError('FORBIDDEN'))).toHaveLength(1);
  });

  it('reads an errors array nested under the response', () => {
    expect(graphqlErrorsOf({ response: { errors: [{ type: 'NOT_FOUND' }] } })).toHaveLength(1);
  });

  it('returns nothing for other errors', () => {
    expect(graphqlErrorsOf(new Error('boom'))).toEqual([]);
    expect(graphqlErrorsOf({ errors: 'not an array' })).toEqual([]);
  });

  it('drops entries that are not objects', () => {
    expect(graphqlErrorsOf({ errors: ['nope', null, { type: 'FORBIDDEN' }] })).toHaveLength(1);
  });
});

describe('isRateLimited', () => {
  it('matches the API rate limit message', () => {
    expect(isRateLimited(requestError(403, 'You have exceeded a secondary rate limit'))).toBe(true);
  });

  it('matches an exhausted remaining header', () => {
    expect(
      isRateLimited(requestError(403, 'Forbidden', { headers: { 'x-ratelimit-remaining': '0' } })),
    ).toBe(true);
  });

  it('matches a retry-after header', () => {
    expect(
      isRateLimited(requestError(403, 'Forbidden', { headers: { 'retry-after': '60' } })),
    ).toBe(true);
  });

  it('does not match a plain permission failure', () => {
    expect(isRateLimited(requestError(403, 'Resource not accessible by integration'))).toBe(false);
    expect(isRateLimited('boom')).toBe(false);
  });
});

describe('isConfigurationError', () => {
  it.each([401, 403])('is true for %i', (status) => {
    expect(isConfigurationError(requestError(status, 'Resource not accessible'))).toBe(true);
  });

  it('is true for a configuration error thrown by this action', () => {
    expect(isConfigurationError(new ConfigurationError('missing'))).toBe(true);
    expect(isConfigurationError(new InputError('bad input'))).toBe(true);
  });

  it.each(['FORBIDDEN', 'INSUFFICIENT_SCOPES', 'NOT_FOUND'])(
    'is true for the GraphQL type %s',
    (type) => {
      expect(isConfigurationError(graphqlError(type))).toBe(true);
    },
  );

  it('is false for other GraphQL error types', () => {
    expect(isConfigurationError(graphqlError('RATE_LIMITED'))).toBe(false);
    expect(isConfigurationError({ errors: [{ message: 'no type at all' }] })).toBe(false);
  });

  it('is false for a rate limited 403', () => {
    expect(isConfigurationError(requestError(403, 'API rate limit exceeded'))).toBe(false);
  });

  it.each([404, 429, 500])('is false for %i', (status) => {
    expect(isConfigurationError(requestError(status, 'oops'))).toBe(false);
  });

  it('is false for a network error', () => {
    expect(isConfigurationError(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('describeError', () => {
  it('includes the status, the request, and the message', () => {
    const description = describeError(requestError(403, 'Resource not accessible by integration'));
    expect(description).toContain('Resource not accessible by integration');
    expect(description).toContain('status 403');
    expect(description).toContain('GET https://api.github.com/repos/o/r/pulls/7');
  });

  it('includes the cause of a wrapped error', () => {
    const error = new Error('request failed', { cause: new Error('socket hang up') });
    expect(describeError(error)).toContain('cause socket hang up');
  });

  it('includes GraphQL error types and messages', () => {
    expect(describeError(graphqlError('FORBIDDEN', 'no access'))).toContain(
      'GraphQL FORBIDDEN: no access',
    );
  });

  it('falls back sensibly for a bare GraphQL entry', () => {
    expect(describeError({ errors: [{}] })).toContain('GraphQL ERROR: no message');
  });

  it('describes a request with no method or url', () => {
    expect(describeError({ request: { url: undefined, method: undefined } })).not.toContain(
      'request GET',
    );
  });

  it('fills in a missing method or url on a partial request', () => {
    expect(describeError({ request: { url: 'https://api.github.com/x' } })).toContain(
      'request GET https://api.github.com/x',
    );
    expect(describeError({ request: { method: 'POST' } })).toContain('request POST unknown');
  });

  it('ignores a null cause', () => {
    expect(describeError({ message: 'boom', cause: null })).toBe('boom');
  });

  it('is never [object Object]', () => {
    expect(describeError({ status: 500 })).not.toContain('[object Object]');
  });
});

describe('applyErrorPolicy', () => {
  it('fails the run on a permission error and names the permissions block', () => {
    applyErrorPolicy(requestError(403, 'Resource not accessible by integration'));
    expect(core.setFailed).toHaveBeenCalledOnce();
    const message = vi.mocked(core.setFailed).mock.calls[0]?.[0] as string;
    expect(message).toContain('status 403');
    expect(message).toContain('pull-requests: write');
    expect(message).not.toContain('pull_request_target');
    expect(core.setOutput).toHaveBeenCalledWith('outcome', 'failed');
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('adds a fork hint for a 403 on pull_request', () => {
    applyErrorPolicy(requestError(403, 'Resource not accessible'), 'pull_request');
    expect(vi.mocked(core.setFailed).mock.calls[0]?.[0]).toContain(
      'Fork pull requests need this action to run on pull_request_target.',
    );
  });

  it('fails the run on a GraphQL permission error that has no status', () => {
    applyErrorPolicy(graphqlError('FORBIDDEN'), 'pull_request_target');
    expect(core.setFailed).toHaveBeenCalledOnce();
  });

  it('fails the run on a bad input', () => {
    applyErrorPolicy(new InputError('poll-seconds is not a number'));
    expect(core.setFailed).toHaveBeenCalledOnce();
  });

  it.each([
    ['a server error', requestError(500, 'server error')],
    ['a rate limited 403', requestError(403, 'API rate limit exceeded')],
    ['an unexpected GraphQL type', graphqlError('RATE_LIMITED')],
    ['a network error', new Error('ECONNRESET')],
  ])('warns and passes on %s', (_name, error) => {
    applyErrorPolicy(error);
    expect(core.warning).toHaveBeenCalledOnce();
    expect(core.setOutput).toHaveBeenCalledWith('outcome', 'failed-open');
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});
