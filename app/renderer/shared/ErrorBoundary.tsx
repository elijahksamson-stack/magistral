/**
 * Pane-level error boundary.
 *
 * One pane throwing must not blank the workstation — the author may have
 * unsaved thinking in the other two. Each pane is wrapped separately so a crash
 * is contained to its own column, and the boundary offers a retry that remounts
 * only that subtree.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import styles from './ErrorBoundary.module.css';

interface ErrorBoundaryProps {
  /** Shown in the fallback so the author knows which pane failed. */
  readonly label: string;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaced, never swallowed: the stack is the only clue for a render crash.
    window.dispatchEvent(
      new CustomEvent('braindump:pane-error', {
        detail: { label: this.props.label, message: error.message, stack: info.componentStack },
      }),
    );
  }

  private readonly retry = (): void => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className={styles.fallback} role="alert">
        <p className={styles.title}>The {this.props.label} pane stopped.</p>
        <p className={styles.detail}>{error.message}</p>
        <button type="button" className={styles.retry} onClick={this.retry}>
          Reload this pane
        </button>
      </div>
    );
  }
}
