/**
 * Builds the `claude` argv.
 *
 * Kept pure and separate from the spawn so the exact command line is unit
 * testable — in particular the assertion that `--dangerously-skip-permissions`
 * is never present, and that `--allowedTools` stays read-only.
 */

import { ALLOWED_TOOLS, type ClaudeBridgeConfig } from '../../../shared/types/claude';

/** Flags this app must never emit, whatever else changes. */
export const FORBIDDEN_FLAGS: readonly string[] = [
  '--dangerously-skip-permissions',
  '--permission-mode',
] as const;

export interface ClaudeArgsInput {
  readonly prompt: string;
  readonly config: ClaudeBridgeConfig;
  /** Absolute path to the action's system-prompt file, when one exists. */
  readonly systemPromptFile?: string;
  readonly resumeSessionId?: string;
}

/**
 * Assemble argv. Directories are deduplicated so `--add-dir` is not passed the
 * same path twice when a vault happens to live under the knowledge dir.
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const { prompt, config, systemPromptFile, resumeSessionId } = input;

  // `--verbose` is REQUIRED here, not optional: the CLI rejects
  // `--print` + `--output-format=stream-json` without it —
  // "Error: When using --print, --output-format=stream-json requires --verbose".
  const args: string[] = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];

  if (systemPromptFile) {
    args.push('--append-system-prompt-file', systemPromptFile);
  }

  for (const dir of dedupe([config.knowledgeDir, config.vaultDir])) {
    args.push('--add-dir', dir);
  }

  args.push('--allowedTools', ...ALLOWED_TOOLS);
  args.push('--model', config.model);

  if (resumeSessionId) args.push('--resume', resumeSessionId);

  return args;
}

function dedupe(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
