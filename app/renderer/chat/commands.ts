/**
 * Slash commands in the chat composer.
 *
 * Modelled on Claude Code, where `/clear` is muscle memory. Parsing is pure and
 * strict: only a message that is EXACTLY a command counts, so a question that
 * merely mentions one — "what does /clear do?" — is sent to the model rather
 * than silently wiping the transcript instead of answering.
 */

export type ChatCommand = { readonly kind: 'clear' } | { readonly kind: 'help' };

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
}

export const CHAT_COMMANDS: readonly CommandSpec[] = [
  { name: '/clear', summary: 'Forget this conversation and start fresh' },
  { name: '/help', summary: 'List the commands' },
];

/**
 * A command, or null when the text is an ordinary message.
 *
 * Leading and trailing whitespace is ignored; anything else on the line is
 * not. "/clear the graph" is a sentence about clearing, not an instruction to
 * clear, and treating it as the latter would destroy a transcript the author
 * meant to ask about.
 */
export function parseCommand(text: string): ChatCommand | null {
  const trimmed = text.trim().toLowerCase();

  if (trimmed === '/clear') return { kind: 'clear' };
  if (trimmed === '/help' || trimmed === '/?') return { kind: 'help' };
  return null;
}

/** True when the text looks like an attempt at a command we do not have. */
export function isUnknownCommand(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;
  if (parseCommand(trimmed) !== null) return false;
  // A single word starting with "/" was meant as a command; a longer line is
  // prose that happens to open with a slash.
  return !trimmed.includes(' ');
}

export function helpText(): string {
  return CHAT_COMMANDS.map((command) => `${command.name} — ${command.summary}`).join('\n');
}
