/**
 * Runtime registry for the local, subscription-authenticated CLI providers.
 * Detection is zero-token: version and login-state checks only.
 */

import type {
  CliProvider,
  CliProviderSelection,
  CliProviderSnapshot,
  CliProviderStatus,
} from '../../../shared/types/claude';
import { isCodexSessionId } from './codex';
import { detectCliProviders, type DetectedCliProvider } from './health';

export type ProviderDetector = () => Promise<DetectedCliProvider[]>;

export interface ProviderRegistryConfig {
  claudeBinaryPath: string;
  claudeAvailable?: boolean;
  codexBinaryPath?: string;
}

export interface ProviderRoute {
  provider: CliProvider;
  allowFallback: boolean;
}

function initialProviders(config: ProviderRegistryConfig): DetectedCliProvider[] {
  const claudeReady = config.claudeAvailable !== false;
  const codexReady = Boolean(config.codexBinaryPath);
  return [
    {
      binaryPath: config.claudeBinaryPath,
      status: {
        id: 'claude',
        label: 'Claude',
        available: claudeReady,
        authenticated: claudeReady,
      },
    },
    {
      ...(config.codexBinaryPath ? { binaryPath: config.codexBinaryPath } : {}),
      status: {
        id: 'codex',
        label: 'ChatGPT',
        available: codexReady,
        authenticated: codexReady,
      },
    },
  ];
}

function isUsable(status: CliProviderStatus): boolean {
  return status.available && status.authenticated;
}

export class CliProviderRegistry {
  private selected: CliProviderSelection = 'auto';
  private providers: DetectedCliProvider[];

  constructor(
    config: ProviderRegistryConfig,
    private readonly detect: ProviderDetector = () => detectCliProviders(),
  ) {
    this.providers = initialProviders(config);
  }

  async snapshot(): Promise<CliProviderSnapshot> {
    this.providers = await this.detect();
    if (this.selected !== 'auto' && !this.usable(this.selected)) this.selected = 'auto';
    return this.currentSnapshot();
  }

  async select(provider: CliProviderSelection): Promise<CliProviderSnapshot> {
    this.providers = await this.detect();
    if (provider !== 'auto' && !this.usable(provider)) {
      const status = this.status(provider);
      throw new Error(status?.reason ?? `${provider} is not available through a local subscription.`);
    }
    this.selected = provider;
    return this.currentSnapshot();
  }

  route(resumeSessionId: string | undefined): ProviderRoute {
    if (this.selected !== 'auto') {
      return { provider: this.selected, allowFallback: false };
    }
    const provider =
      isCodexSessionId(resumeSessionId) || !this.usable('claude') ? 'codex' : 'claude';
    return { provider, allowFallback: true };
  }

  binaryPath(provider: CliProvider): string | undefined {
    return this.providers.find((candidate) => candidate.status.id === provider)?.binaryPath;
  }

  private usable(provider: CliProvider): boolean {
    const status = this.status(provider);
    return status ? isUsable(status) : false;
  }

  private status(provider: CliProvider): CliProviderStatus | undefined {
    return this.providers.find((candidate) => candidate.status.id === provider)?.status;
  }

  private currentSnapshot(): CliProviderSnapshot {
    return {
      providers: this.providers.map(({ status }) => ({ ...status })),
      selected: this.selected,
    };
  }
}
