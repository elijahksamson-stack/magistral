import { describe, expect, it } from 'vitest';
import type { CliProviderStatus } from '../../../shared/types/claude';
import type { DetectedCliProvider } from './health';
import { CliProviderRegistry } from './providers';

function detected(
  id: CliProviderStatus['id'],
  authenticated = true,
): DetectedCliProvider {
  return {
    binaryPath: `/local/bin/${id}`,
    status: {
      id,
      label: id === 'claude' ? 'Claude' : 'ChatGPT',
      available: true,
      authenticated,
      ...(authenticated ? {} : { reason: `${id} is signed out` }),
    },
  };
}

function registry(providers: DetectedCliProvider[]): CliProviderRegistry {
  return new CliProviderRegistry(
    { claudeBinaryPath: '/initial/claude', codexBinaryPath: '/initial/codex' },
    async () => providers,
  );
}

describe('CliProviderRegistry', () => {
  it('reports every detected provider and defaults to automatic routing', async () => {
    const providers = registry([detected('claude'), detected('codex')]);

    await expect(providers.snapshot()).resolves.toMatchObject({
      selected: 'auto',
      providers: [{ id: 'claude' }, { id: 'codex' }],
    });
    expect(providers.route(undefined)).toEqual({ provider: 'claude', allowFallback: true });
  });

  it('pins an authenticated provider and disables silent fallback', async () => {
    const providers = registry([detected('claude'), detected('codex')]);

    await expect(providers.select('codex')).resolves.toMatchObject({ selected: 'codex' });
    expect(providers.route(undefined)).toEqual({ provider: 'codex', allowFallback: false });
  });

  it('rejects a signed-out provider', async () => {
    const providers = registry([detected('claude'), detected('codex', false)]);

    await expect(providers.select('codex')).rejects.toThrow(/signed out/);
  });

  it('keeps a tagged Codex conversation with Codex while routing automatically', async () => {
    const providers = registry([detected('claude'), detected('codex')]);
    await providers.snapshot();

    expect(providers.route('codex:thread-1')).toEqual({
      provider: 'codex',
      allowFallback: true,
    });
  });
});
