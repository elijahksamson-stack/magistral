import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import StreamingOverlay from './StreamingOverlay';
import type { CellRunView } from './useCellRun';

function completedRun(): CellRunView {
  return {
    requestId: 'run-1',
    action: 'enhance',
    isStreaming: false,
    packs: ['mindset/seeing-clearly', 'sector/technology/semiconductors#2'],
    streamedText: 'Better text',
    usage: null,
    error: null,
    preview: {
      action: 'enhance',
      baseMarkdown: 'Original text',
      streamedText: 'Better text',
    },
    proposedMarkdown: 'Better text',
    diff: [
      { kind: 'removed', text: 'Original text' },
      { kind: 'added', text: 'Better text' },
    ],
    diffStats: { added: 1, removed: 1 },
    canDecide: true,
  };
}

describe('StreamingOverlay', () => {
  it('shows the proposal without exposing internal knowledge-routing details', () => {
    const html = renderToStaticMarkup(
      <StreamingOverlay
        run={completedRun()}
        onCancel={() => undefined}
        onAccept={() => undefined}
        onReject={() => undefined}
      />,
    );

    expect(html).toContain('Better text');
    expect(html).not.toContain('Knowledge injected');
    expect(html).not.toContain('mindset/seeing-clearly');
    expect(html).not.toContain('sector/technology/semiconductors#2');
  });
});
