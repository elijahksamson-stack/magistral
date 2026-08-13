/**
 * Presenting what a ✦ run consumed.
 *
 * The CLI rides the user's subscription. `notionalCostUsd` is the CLI's own
 * token weighting, NOT money leaving an account, so it is NEVER rendered as a
 * price. It is shown only as a share of the subscription's notional monthly
 * weighting, alongside the raw token counts.
 */

import type { ClaudeUsage } from '../../../shared/types/claude';

/**
 * The notional monthly weighting a subscription is treated as covering. A unit
 * of account for the share readout — not a currency amount, not a balance.
 */
export const SUBSCRIPTION_NOTIONAL_WEIGHT = 100;

const THOUSAND = 1000;
const MILLION = 1_000_000;
const SHARE_DECIMALS = 2;
const MIN_SHOWN_SHARE_PERCENT = 0.01;

export function totalTokens(usage: ClaudeUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheCreationTokens
  );
}

/** `1234` -> `"1.2k"`. Compact enough for a status strip. */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '—';
  if (count < THOUSAND) return String(Math.round(count));
  if (count < MILLION) return `${(count / THOUSAND).toFixed(1)}k`;
  return `${(count / MILLION).toFixed(2)}M`;
}

/** This run's share of the subscription's notional monthly weighting, in percent. */
export function subscriptionSharePercent(usage: ClaudeUsage): number {
  if (!Number.isFinite(usage.notionalCostUsd) || usage.notionalCostUsd <= 0) return 0;
  return (usage.notionalCostUsd / SUBSCRIPTION_NOTIONAL_WEIGHT) * 100;
}

export function formatSubscriptionShare(usage: ClaudeUsage): string {
  const percent = subscriptionSharePercent(usage);
  if (percent <= 0) return '<0.01% of monthly subscription';
  if (percent < MIN_SHOWN_SHARE_PERCENT) return '<0.01% of monthly subscription';
  return `${percent.toFixed(SHARE_DECIMALS)}% of monthly subscription`;
}

export interface UsageSummary {
  totalLabel: string;
  inputLabel: string;
  outputLabel: string;
  cachedLabel: string;
  shareLabel: string;
}

/** Everything the overlay needs to render usage, already formatted. */
export function summarizeUsage(usage: ClaudeUsage): UsageSummary {
  return {
    totalLabel: formatTokenCount(totalTokens(usage)),
    inputLabel: formatTokenCount(usage.inputTokens),
    outputLabel: formatTokenCount(usage.outputTokens),
    cachedLabel: formatTokenCount(usage.cacheReadTokens + usage.cacheCreationTokens),
    shareLabel: formatSubscriptionShare(usage),
  };
}
