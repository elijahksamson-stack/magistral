import { useCallback, useEffect, useState } from 'react';
import type {
  CliProviderSelection,
  CliProviderSnapshot,
  CliProviderStatus,
} from '../../../shared/types/claude';
import { invoke, toMessage } from './api';
import styles from './ProviderSelector.module.css';

export function usable(provider: CliProviderStatus): boolean {
  return provider.available && provider.authenticated;
}

export function hasUsableProvider(snapshot: CliProviderSnapshot | null): boolean {
  return snapshot?.providers.some(usable) ?? false;
}

function providerTitle(provider: CliProviderStatus): string {
  if (provider.reason) return provider.reason;
  return provider.version ? `${provider.label} · ${provider.version}` : provider.label;
}

export interface ProviderSelectorProps {
  onSnapshot?: (snapshot: CliProviderSnapshot | null) => void;
  /** Keep detection alive without reserving chrome when no CLI can be used. */
  hideWhenUnavailable?: boolean;
}

export default function ProviderSelector({
  onSnapshot,
  hideWhenUnavailable = false,
}: ProviderSelectorProps = {}): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<CliProviderSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await invoke('llm:providers', undefined);
      setSnapshot(next);
      onSnapshot?.(next);
      setError(null);
    } catch (cause: unknown) {
      setSnapshot(null);
      onSnapshot?.(null);
      setError(toMessage(cause));
    }
  }, [onSnapshot]);

  useEffect(() => {
    void refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const select = useCallback(async (provider: CliProviderSelection): Promise<void> => {
    setSelecting(true);
    try {
      const next = await invoke('llm:select', { provider });
      setSnapshot(next);
      onSnapshot?.(next);
      setError(null);
    } catch (cause: unknown) {
      setError(toMessage(cause));
    } finally {
      setSelecting(false);
    }
  }, [onSnapshot]);

  const providers = snapshot?.providers.filter(usable) ?? [];
  if (!snapshot) {
    if (hideWhenUnavailable) return null;
    return (
      <span className={styles.empty} title={error ?? 'Checking local CLI subscriptions'}>
        {error ? 'No local LLM' : 'Detecting LLMs…'}
      </span>
    );
  }

  if (providers.length === 0) {
    if (hideWhenUnavailable) return null;
    const reason = snapshot.providers.map((provider) => provider.reason).filter(Boolean).join(' ');
    return (
      <span className={styles.empty} title={reason || 'No authenticated local LLM CLI detected'}>
        No local LLM
      </span>
    );
  }

  return (
    <div className={styles.selector} role="group" aria-label="Answer with local LLM">
      {providers.length > 1 ? (
        <button
          type="button"
          className={styles.option}
          aria-pressed={snapshot.selected === 'auto'}
          disabled={selecting}
          title="Claude first, then ChatGPT if Claude reaches its allowance limit"
          onClick={() => void select('auto')}
        >
          Auto
        </button>
      ) : null}
      {providers.map((provider) => {
        const active =
          snapshot.selected === provider.id ||
          (providers.length === 1 && snapshot.selected === 'auto');
        return (
          <button
            key={provider.id}
            type="button"
            className={styles.option}
            aria-pressed={active}
            disabled={selecting}
            title={providerTitle(provider)}
            onClick={() => void select(provider.id)}
          >
            {provider.label}
          </button>
        );
      })}
      {error ? <span className={styles.error} title={error}>!</span> : null}
    </div>
  );
}
