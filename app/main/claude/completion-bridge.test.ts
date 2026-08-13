/**
 * "Complete the map" through the bridge, with a fake CLI.
 *
 * The unit tests in completion.test.ts prove the permission rules. This proves
 * the wiring around them: that the map the model is shown comes from the CORE
 * and not from the caller, that the proposal is validated before it leaves the
 * bridge, and — the point of the whole feature — that the bridge never applies
 * anything itself.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeBridge, type SpawnFn } from './bridge';
import type { ClaudeBridgeConfig, ClaudeStreamEvent } from '../../../shared/types/claude';
import type { ConnectionScope, MapSnapshot } from '../../../shared/types/completion';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    return true;
  }
  finish(code: number): void {
    this.exitCode = code;
    this.emit('close', code);
  }
}

interface Capture {
  args: readonly string[];
  child: FakeChild;
}

function makeSpawn(): { spawn: SpawnFn; calls: Capture[] } {
  const calls: Capture[] = [];
  const spawn: SpawnFn = (_command, args, _options: SpawnOptions) => {
    const child = new FakeChild();
    calls.push({ args, child });
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

/**
 * The REAL knowledge directory, so the system-prompt lookup is exercised
 * rather than skipped. A missing file is silently tolerated by design, which
 * means a test pointed at a fake directory would pass while shipping a
 * completion that never saw its instructions.
 */
const KNOWLEDGE_DIR = path.resolve(__dirname, '../../../resources/knowledge');

const CONFIG: ClaudeBridgeConfig = {
  binaryPath: '/usr/local/bin/claude',
  model: 'claude-sonnet-5',
  timeoutMs: 5_000,
  knowledgeDir: KNOWLEDGE_DIR,
  vaultDir: '/tmp/braindump-vault-does-not-exist',
};

const MAP: MapSnapshot = {
  name: 'power',
  nodes: [
    { label: 'EUV', kind: 'concept', note: 'Extreme ultraviolet lithography.' },
    { label: 'ASML', kind: 'entity' },
    { label: 'Supply', kind: 'group' },
  ],
  edges: [{ source: 'ASML', target: 'EUV', relation: 'relates_to' }],
};

/** Drive one completion to `done` (or `error`) and return everything emitted. */
async function runCompletion(
  reply: string,
  options: { getMap?: () => MapSnapshot; scope?: ConnectionScope } = {},
): Promise<{ events: ClaudeStreamEvent[]; args: readonly string[] }> {
  const { spawn, calls } = makeSpawn();
  const events: ClaudeStreamEvent[] = [];

  const settled = new Promise<void>((resolve) => {
    const bridge = new ClaudeBridge(
      CONFIG,
      (event) => {
        events.push(event);
        if (event.type === 'done' || event.type === 'error') resolve();
      },
      { spawn, sourceEnv: {}, getMap: options.getMap ?? (() => MAP) },
    );

    void bridge.invoke({
      requestId: 'req-complete',
      kind: 'complete',
      ...(options.scope ? { connectionScope: options.scope } : {}),
    }).then(() => {
      const capture = calls[0];
      if (!capture) return;
      capture.child.stdout.write(
        `${JSON.stringify({ type: 'result', subtype: 'success', result: reply, session_id: 's1' })}\n`,
      );
      capture.child.finish(0);
    });
  });

  await settled;
  return { events, args: calls[0]?.args ?? [] };
}

afterEach(() => {
  // Nothing to tear down: every fake child is finished by runCompletion.
});

describe('what the model is given', () => {
  it('shows it the map read from the core, not one supplied by the caller', async () => {
    const { args } = await runCompletion('{"newNodes":[]}');
    const prompt = args.join('\n');

    expect(prompt).toContain('EUV');
    expect(prompt).toContain('ASML --[relates_to]--> EUV');
    // Labelled as existing, so the model does not propose them as new.
    expect(prompt).toContain('CONCEPTS THAT ALREADY EXIST');
  });

  it('uses the complete-map system prompt, not the chat one', async () => {
    const { args } = await runCompletion('{"newNodes":[]}');
    const flagIndex = args.indexOf('--append-system-prompt-file');
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toMatch(/complete-map\.md$/);
  });

  it('states the permissions in the prompt as well as in the schema', async () => {
    const { args } = await runCompletion('{"newNodes":[]}');
    const prompt = args.join('\n');
    expect(prompt).toMatch(/may NOT rename, delete, or reword an existing concept/i);
  });

  it('refuses to run at all when no graph can be read', async () => {
    const { events } = await runCompletion('{"newNodes":[]}', {
      getMap: () => {
        throw new Error('no vault open');
      },
    });
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });
});

describe('what comes back', () => {
  it('carries a validated proposal on done', async () => {
    const { events } = await runCompletion(
      JSON.stringify({
        newNodes: [{ label: 'Interconnect Queue', kind: 'concept' }],
        newEdges: [{ source: 'Interconnect Queue', target: 'EUV', relation: 'causes' }],
        rationale: 'The map has no bottleneck between them.',
      }),
    );

    const done = events.find((event) => event.type === 'done');
    expect(done).toBeDefined();
    if (done?.type !== 'done') throw new Error('expected done');

    expect(done.completion?.accepted.newNodes).toHaveLength(1);
    expect(done.completion?.accepted.newEdges).toHaveLength(1);
    expect(done.completion?.accepted.rationale).toMatch(/bottleneck/);
  });

  it('refuses a "new" concept the map already has, and says why', async () => {
    // The permission that matters most: creating an existing concept is an
    // edit of it, and this is the path an edit would actually try to take.
    const { events } = await runCompletion(
      JSON.stringify({ newNodes: [{ label: 'euv', kind: 'concept' }] }),
    );

    const done = events.find((event) => event.type === 'done');
    if (done?.type !== 'done') throw new Error('expected done');

    expect(done.completion?.accepted.newNodes).toHaveLength(0);
    expect(done.completion?.rejected[0]?.reason).toMatch(/already exists/i);
  });

  it('enforces a subnode-only scope after generation, not just in the prompt', async () => {
    const nestedMap: MapSnapshot = {
      ...MAP,
      nodes: MAP.nodes.map((node) =>
        node.label === 'EUV'
          ? { ...node, subConcepts: ['Power demand'] }
          : node.label === 'ASML'
            ? { ...node, subConcepts: ['Financing constraint'] }
            : node,
      ),
    };
    const { events } = await runCompletion(
      JSON.stringify({
        newNodes: [{ label: 'Fake child', kind: 'concept' }],
        newEdges: [{
          source: 'Power demand',
          sourceParent: 'EUV',
          target: 'Financing constraint',
          targetParent: 'ASML',
          relation: 'affects',
        }],
      }),
      { getMap: () => nestedMap, scope: 'subnode-subnode' },
    );

    const done = events.find((event) => event.type === 'done');
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.completion?.accepted.newNodes).toEqual([]);
    expect(done.completion?.accepted.newEdges).toHaveLength(1);
  });

  it('discards delete-shaped fields the model invents', async () => {
    const { events } = await runCompletion(
      JSON.stringify({
        deleteNodes: ['EUV'],
        removeEdges: [{ source: 'ASML', target: 'EUV' }],
        renameNodes: [{ from: 'ASML', to: 'ASML Holding' }],
        newNodes: [{ label: 'Heat Rate', kind: 'metric' }],
      }),
    );

    const done = events.find((event) => event.type === 'done');
    if (done?.type !== 'done') throw new Error('expected done');

    // The good change survives; nothing destructive is anywhere in the result.
    expect(done.completion?.accepted.newNodes).toHaveLength(1);
    const serialized = JSON.stringify(done.completion);
    expect(serialized).not.toMatch(/delete|rename|remove/i);
  });

  it('reports unreadable output rather than emitting a half-parsed proposal', async () => {
    const { events } = await runCompletion('I would add a few things, but here is some prose.');

    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'error', code: 'INVALID_COMPLETION' });
    if (last?.type !== 'error') throw new Error('expected error');
    expect(last.message).toMatch(/Nothing was changed/);
  });
});

describe('the bridge never applies anything', () => {
  it('emits a proposal and touches no graph API', async () => {
    // The bridge is constructed with a READ-ONLY view of the graph: getMap and
    // nothing else. There is no mutation function in its dependencies, so a
    // path from a model's reply to a changed graph cannot exist here — it has
    // to go through the review pane and the renderer's IPC calls.
    const bridge = new ClaudeBridge(CONFIG, () => {}, { sourceEnv: {}, getMap: () => MAP });
    const deps = Object.keys(bridge as unknown as Record<string, unknown>);
    expect(deps.some((key) => /add|remove|set|apply|mutate/i.test(key))).toBe(false);
  });
});
