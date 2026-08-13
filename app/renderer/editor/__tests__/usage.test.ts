/**
 * Usage rides the subscription. The readout must show tokens and a share —
 * never a price.
 */

import { describe, expect, it } from 'vitest';
import type { ClaudeUsage } from '../../../../shared/types/claude';
import {
  SUBSCRIPTION_NOTIONAL_WEIGHT,
  formatSubscriptionShare,
  formatTokenCount,
  subscriptionSharePercent,
  summarizeUsage,
  totalTokens,
} from '../usage';

function makeUsage(overrides: Partial<ClaudeUsage> = {}): ClaudeUsage {
  return {
    inputTokens: 1200,
    outputTokens: 800,
    cacheReadTokens: 400,
    cacheCreationTokens: 100,
    notionalCostUsd: 0.5,
    ...overrides,
  };
}

describe('totalTokens', () => {
  it('sums every token bucket', () => {
    expect(totalTokens(makeUsage())).toBe(2500);
  });
});

describe('formatTokenCount', () => {
  it('shows small counts exactly', () => {
    expect(formatTokenCount(942)).toBe('942');
  });

  it('abbreviates thousands and millions', () => {
    expect(formatTokenCount(2500)).toBe('2.5k');
    expect(formatTokenCount(1_250_000)).toBe('1.25M');
  });

  it('degrades gracefully on nonsense input', () => {
    expect(formatTokenCount(Number.NaN)).toBe('—');
    expect(formatTokenCount(-5)).toBe('—');
  });
});

describe('subscription share', () => {
  it('expresses the notional weighting as a percentage of the subscription', () => {
    const usage = makeUsage({ notionalCostUsd: SUBSCRIPTION_NOTIONAL_WEIGHT / 4 });
    expect(subscriptionSharePercent(usage)).toBeCloseTo(25);
  });

  it('never renders a currency symbol or a dollar figure', () => {
    const label = formatSubscriptionShare(makeUsage({ notionalCostUsd: 1.2345 }));

    expect(label).not.toMatch(/\$/);
    expect(label).not.toMatch(/usd/i);
    expect(label).toContain('subscription');
  });

  it('floors tiny runs rather than showing a misleading zero', () => {
    expect(formatSubscriptionShare(makeUsage({ notionalCostUsd: 0 }))).toBe(
      '<0.01% of monthly subscription',
    );
  });
});

describe('summarizeUsage', () => {
  it('formats every field the overlay renders', () => {
    expect(summarizeUsage(makeUsage())).toEqual({
      totalLabel: '2.5k',
      inputLabel: '1.2k',
      outputLabel: '800',
      cachedLabel: '500',
      shareLabel: '0.50% of monthly subscription',
    });
  });
});
