export interface MemoryEntry {
  sessionId: string;
  type: 'note' | 'context' | 'summary';
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface SessionMemory {
  sessionId: string;
  entries: MemoryEntry[];
}

export interface MemoryStore {
  addEntry(entry: MemoryEntry): Promise<void>;
  getSession(sessionId: string): Promise<SessionMemory | null>;
  listSessions(): Promise<string[]>;
  clearSession(sessionId: string): Promise<void>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly sessions = new Map<string, MemoryEntry[]>();

  async addEntry(entry: MemoryEntry): Promise<void> {
    const { sessionId } = entry;
    const entries = this.sessions.get(sessionId) ?? [];
    entries.push(entry);
    this.sessions.set(sessionId, entries);
  }

  async getSession(sessionId: string): Promise<SessionMemory | null> {
    const entries = this.sessions.get(sessionId);
    if (!entries) {
      return null;
    }
    // Sort entries by timestamp ascending for chronological history
    const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt);
    return { sessionId, entries: sorted };
  }

  async listSessions(): Promise<string[]> {
    return Array.from(this.sessions.keys());
  }

  async clearSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
