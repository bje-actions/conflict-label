import * as core from '@actions/core';
import { context } from '@actions/github';
import { createClient, createOctokit } from './github';
import { applyErrorPolicy } from './policy';
import { resolveOptions, run } from './run';

async function main(): Promise<void> {
  const options = resolveOptions(
    {
      label: core.getInput('label'),
      pollSeconds: core.getInput('poll-seconds'),
      prNumber: core.getInput('pr-number'),
    },
    context,
  );

  const client = createClient(createOctokit(core.getInput('token', { required: true })), {
    owner: context.repo.owner,
    repo: context.repo.repo,
  });

  await run(options, client);
}

main().catch(applyErrorPolicy);
