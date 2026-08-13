/**
 * Small typed wrapper over localStorage for view state.
 *
 * WHAT BELONGS HERE: which cells are folded, whether the editor is collapsed,
 * the chat transcript. Things that describe how the author is looking at a
 * graph, not what the graph says.
 *
 * WHAT DOES NOT: anything that belongs to the knowledge itself. That lives in
 * the vault, behind a schema — and widening that schema is what locked a real
 * vault shut once already. View state has no business forcing a migration.
 *
 * Every read is defensive. localStorage is shared, writable by anything in the
 * origin, and survives across versions of this app, so its contents are
 * untrusted input rather than something we put there.
 */

const NAMESPACE = 'braindump.v1';

function keyFor(scope: string, vaultId: string | null): string {
  return `${NAMESPACE}.${scope}.${vaultId ?? 'no-vault'}`;
}

/**
 * Session-only stand-in.
 *
 * Used when the host gives us nothing usable — private browsing, a hardened
 * embedder, or a test runner whose `localStorage` is a stub. Memory is better
 * than an exception on every fold: the author loses stickiness across
 * restarts, not the ability to fold at all.
 */
const memoryStore = new Map<string, string>();

const memoryFallback: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem: (key) => memoryStore.get(key) ?? null,
  setItem: (key, value) => void memoryStore.set(key, value),
  removeItem: (key) => void memoryStore.delete(key),
};

/** True when the object actually implements the three methods we call. */
function isUsable(candidate: unknown): candidate is Storage {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const store = candidate as Partial<Storage>;
  return (
    typeof store.getItem === 'function' &&
    typeof store.setItem === 'function' &&
    typeof store.removeItem === 'function'
  );
}

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  try {
    // The WINDOW's storage specifically: Node 25 defines a `localStorage`
    // global of its own, so a bare reference can resolve to something that is
    // not the DOM's. Checked for the methods rather than trusted, because both
    // that global and a stubbed one answer to the name without implementing it.
    if (typeof window !== 'undefined' && isUsable(window.localStorage)) {
      return window.localStorage;
    }
  } catch {
    // Touching localStorage itself throws in some privacy modes.
  }
  return memoryFallback;
}

/** Read a value, or `fallback` when absent, unparseable, or the wrong shape. */
export function readPersisted<T>(
  scope: string,
  vaultId: string | null,
  isValid: (value: unknown) => value is T,
  fallback: T,
): T {
  const store = storage();

  try {
    const raw = store.getItem(keyFor(scope, vaultId));
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : fallback;
  } catch {
    // A quota error, a private-browsing block, or corrupt JSON. None of these
    // are worth interrupting the author over — they just mean no memory.
    return fallback;
  }
}

export function writePersisted(scope: string, vaultId: string | null, value: unknown): void {
  const store = storage();

  try {
    store.setItem(keyFor(scope, vaultId), JSON.stringify(value));
  } catch {
    // Storage full or unavailable. Losing the memory of a folded cell is not
    // worth an error in the author's face.
  }
}

export function clearPersisted(scope: string, vaultId: string | null): void {
  const store = storage();
  try {
    store.removeItem(keyFor(scope, vaultId));
  } catch {
    // Same reasoning as above.
  }
}

// ---------------------------------------------------------------------------
// Shape guards
// ---------------------------------------------------------------------------

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
