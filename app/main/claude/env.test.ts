import { describe, expect, it } from 'vitest';
import { STRIPPED_ENV_KEYS } from '../../../shared/types/claude';
import {
  CODEX_STRIPPED_ENV_KEYS,
  buildChildEnv,
  buildCodexChildEnv,
  hasBillingLeak,
  hasCodexBillingLeak,
} from './env';

describe('buildChildEnv', () => {
  it('removes every stripped key', () => {
    const source = Object.fromEntries(STRIPPED_ENV_KEYS.map((key) => [key, 'value']));

    const result = buildChildEnv({ ...source, PATH: '/bin' });

    expect(Object.keys(result)).toEqual(['PATH']);
  });

  it('is case-insensitive, so a lowercase alias cannot slip through', () => {
    const result = buildChildEnv({ anthropic_api_key: 'sk-ant-lowercase', PATH: '/bin' });

    expect(result).toEqual({ PATH: '/bin' });
  });

  it('keeps unrelated variables untouched', () => {
    const result = buildChildEnv({ PATH: '/bin', HOME: '/Users/x', TERM: 'xterm' });

    expect(result).toEqual({ PATH: '/bin', HOME: '/Users/x', TERM: 'xterm' });
  });

  it('drops undefined values rather than passing "undefined" strings', () => {
    const result = buildChildEnv({ PATH: '/bin', EMPTY: undefined });

    expect('EMPTY' in result).toBe(false);
  });

  it('does not mutate its input', () => {
    const source = { ANTHROPIC_API_KEY: 'sk-ant-x', PATH: '/bin' };

    buildChildEnv(source);

    expect(source.ANTHROPIC_API_KEY).toBe('sk-ant-x');
  });
});

describe('buildCodexChildEnv', () => {
  it('removes OpenAI and Anthropic API billing keys', () => {
    const source = Object.fromEntries(
      [...STRIPPED_ENV_KEYS, ...CODEX_STRIPPED_ENV_KEYS].map((key) => [key, 'value']),
    );

    expect(buildCodexChildEnv({ ...source, PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });

  it('detects a surviving OpenAI key regardless of case', () => {
    expect(hasCodexBillingLeak({ OpenAI_Api_Key: 'sk-openai-x' })).toBe(true);
  });

  it('passes a clean Codex environment', () => {
    const clean = buildCodexChildEnv({ OPENAI_API_KEY: 'sk', PATH: '/bin' });
    expect(hasCodexBillingLeak(clean)).toBe(false);
  });
});

describe('hasBillingLeak', () => {
  it('detects a surviving key', () => {
    expect(hasBillingLeak({ ANTHROPIC_API_KEY: 'sk-ant-x' })).toBe(true);
  });

  it('detects a surviving key regardless of case', () => {
    expect(hasBillingLeak({ Anthropic_Api_Key: 'sk-ant-x' })).toBe(true);
  });

  it('passes a clean environment', () => {
    expect(hasBillingLeak(buildChildEnv({ ANTHROPIC_API_KEY: 'sk', PATH: '/bin' }))).toBe(false);
  });
});
