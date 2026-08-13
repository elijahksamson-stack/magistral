/**
 * argv construction — regression guards for flags that must (and must never)
 * appear on the spawned CLI command line.
 */

import { describe, expect, it } from 'vitest';

import { buildClaudeArgs, FORBIDDEN_FLAGS } from './args';
import { ALLOWED_TOOLS, type ClaudeBridgeConfig } from '../../../shared/types/claude';

const CONFIG: ClaudeBridgeConfig = {
  binaryPath: '/usr/local/bin/claude',
  model: 'sonnet',
  timeoutMs: 120_000,
  knowledgeDir: '/app/resources/knowledge',
  vaultDir: '/vaults/v1',
};

describe('buildClaudeArgs', () => {
  it('passes --verbose, which the CLI requires alongside --print + stream-json', () => {
    // Shipped without this once. The CLI rejected every invocation with
    // "When using --print, --output-format=stream-json requires --verbose"
    // and the whole chat pane failed with SPAWN_FAILED.
    const args = buildClaudeArgs({ prompt: 'hello', config: CONFIG });

    expect(args).toContain('--verbose');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('-p');
  });

  it('never emits a forbidden flag', () => {
    const args = buildClaudeArgs({
      prompt: 'hello',
      config: CONFIG,
      systemPromptFile: '/app/resources/knowledge/_system/chat.md',
      resumeSessionId: 'sess-1',
    });
    for (const flag of FORBIDDEN_FLAGS) {
      expect(args).not.toContain(flag);
    }
  });

  it('keeps the tool grant read-only', () => {
    const args = buildClaudeArgs({ prompt: 'hello', config: CONFIG });
    const at = args.indexOf('--allowedTools');
    expect(at).toBeGreaterThan(-1);
    expect(args.slice(at + 1, at + 1 + ALLOWED_TOOLS.length)).toEqual([...ALLOWED_TOOLS]);
  });

  it('scopes --add-dir to knowledge and vault, without duplicates', () => {
    const args = buildClaudeArgs({
      prompt: 'hello',
      config: { ...CONFIG, vaultDir: CONFIG.knowledgeDir },
    });
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(1);
  });

  it('resumes only when a session id is supplied', () => {
    expect(buildClaudeArgs({ prompt: 'x', config: CONFIG })).not.toContain('--resume');
    const resumed = buildClaudeArgs({ prompt: 'x', config: CONFIG, resumeSessionId: 's1' });
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe('s1');
  });
});
