import { describe, it, expect } from 'vitest';
import { InMemoryMemoryStore } from '../ai/memory';

describe('InMemoryMemoryStore', () => {
  it('preserves chronological entries', async () => {
    const store = new InMemoryMemoryStore();
    const now = Date.now();

    await store.addEntry({ sessionId: 'session-1', type: 'note', content: 'first', createdAt: now });
    await store.addEntry({ sessionId: 'session-1', type: 'note', content: 'second', createdAt: now + 1000 });

    const session = await store.getSession('session-1');
    expect(session?.entries.length).toBe(2);
    expect(session?.entries[0].content).toBe('first');
    expect(session?.entries[1].content).toBe('second');
  });

  it('supports clearing sessions', async () => {
    const store = new InMemoryMemoryStore();
    const now = Date.now();

    await store.addEntry({ sessionId: 'session-1', type: 'note', content: 'first', createdAt: now });
    await store.clearSession('session-1');

    const session = await store.getSession('session-1');
    expect(session).toBeNull();
    expect(await store.listSessions()).toEqual([]);
  });
});
