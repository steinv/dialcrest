/**
 * Manual jest mock for firebase-admin, used by tests that exercise
 * functions/src/subscription.ts and functions/src/index.ts without touching a
 * real Firebase project. Provides a tiny in-memory tree store that mimics just
 * the slice of the Realtime Database API this codebase actually uses:
 * ref(path).once('value') / .set() / .update() / .remove() / .transaction().
 *
 * Enabled per-test-file via `jest.mock('firebase-admin')` (no factory needed —
 * Jest resolves manual mocks for node_modules packages from this directory).
 * Call `(admin as any).__resetDatabase()` in a beforeEach to isolate tests.
 */

type Tree = Record<string, unknown>;

let store: Tree = {};

function segments(path: string): string[] {
    return path.split('/').filter((s) => s.length > 0);
}

function getAtPath(path: string): unknown {
    let node: unknown = store;
    for (const seg of segments(path)) {
        if (node === null || typeof node !== 'object') return undefined;
        node = (node as Tree)[seg];
    }
    return node;
}

function setAtPath(path: string, value: unknown): void {
    const segs = segments(path);
    if (segs.length === 0) {
        store = (value ?? {}) as Tree;
        return;
    }
    let node: Tree = store;
    for (const seg of segs.slice(0, -1)) {
        const next = node[seg];
        if (next === null || typeof next !== 'object') {
            node[seg] = {};
        }
        node = node[seg] as Tree;
    }
    const last = segs[segs.length - 1];
    if (value === null || value === undefined) {
        delete node[last];
    } else {
        node[last] = value;
    }
}

function updateAtPath(path: string, patch: Record<string, unknown>): void {
    const current = getAtPath(path);
    const base = (current && typeof current === 'object') ? current as Tree : {};
    setAtPath(path, { ...base, ...patch });
}

function removeAtPath(path: string): void {
    setAtPath(path, null);
}

function makeSnapshot(value: unknown) {
    return {
        exists: () => value !== undefined && value !== null,
        val: () => (value === undefined ? null : value),
    };
}

function ref(path: string) {
    return {
        once: async (_event: 'value') => makeSnapshot(getAtPath(path)),
        set: async (value: unknown) => {
            setAtPath(path, value);
        },
        update: async (patch: Record<string, unknown>) => {
            updateAtPath(path, patch);
        },
        remove: async () => {
            removeAtPath(path);
        },
        transaction: async (updateFn: (current: unknown) => unknown) => {
            const current = getAtPath(path);
            const result = updateFn(current === undefined ? null : current);
            if (result === undefined) {
                return { committed: false, snapshot: makeSnapshot(current) };
            }
            setAtPath(path, result);
            return { committed: true, snapshot: makeSnapshot(result) };
        },
    };
}

const database = () => ({ ref });

const admin = {
    initializeApp: () => undefined,
    database,
    /** Test-only helper: wipes the fake tree between tests. */
    __resetDatabase: () => {
        store = {};
    },
    /** Test-only helper: inspect the fake tree directly for assertions. */
    __getDatabaseTree: () => store,
};

export = admin;
