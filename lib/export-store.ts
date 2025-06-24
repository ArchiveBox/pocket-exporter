import fs from 'fs';
import path from 'path';

interface ExportSession {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'rate-limited';
  progress: number;
  totalCount: number;
  fetchedCount: number;
  articles: Article[];
  cursor: string | null;
  error?: string;
  rateLimitedAt?: Date;
  rateLimitRetryAfter?: number;
  startedAt: Date;
  completedAt?: Date;
  auth: {
    cookieString: string;
    headers: Record<string, string>;
  };
}

interface Article {
  id: string;
  title: string;
  url: string;
  tags: string[];
  featured_image?: string;
  added_at: string;
  excerpt?: string;
  domain?: string;
  time_to_read?: number;
}

class ExportStore {
  private sessions: Map<string, ExportSession> = new Map();
  private sessionsDir = path.join(process.cwd(), 'sessions');

  constructor() {
    // Ensure sessions directory exists
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
    // Load existing sessions from disk
    this.loadSessionsFromDisk();
  }

  private loadSessionsFromDisk(): void {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const filePath = path.join(this.sessionsDir, file);
            const data = fs.readFileSync(filePath, 'utf8');
            const session = JSON.parse(data, (key, value) => {
              // Convert date strings back to Date objects
              if (key === 'startedAt' || key === 'completedAt' || key === 'rateLimitedAt') {
                return value ? new Date(value) : value;
              }
              return value;
            });
            this.sessions.set(session.id, session);
          } catch (error) {
            console.error(`Failed to load session ${file}:`, error);
          }
        }
      }
      console.log(`Loaded ${this.sessions.size} sessions from disk`);
    } catch (error) {
      console.error('Failed to load sessions from disk:', error);
    }
  }

  private saveSessionToDisk(session: ExportSession): void {
    try {
      const filePath = path.join(this.sessionsDir, `${session.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
    } catch (error) {
      console.error(`Failed to save session ${session.id} to disk:`, error);
    }
  }

  private deleteSessionFromDisk(id: string): void {
    try {
      const filePath = path.join(this.sessionsDir, `${id}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.error(`Failed to delete session ${id} from disk:`, error);
    }
  }

  createSession(auth: { cookieString: string; headers: Record<string, string> }): string {
    const id = Math.random().toString(36).substring(2) + Date.now().toString(36);
    const session: ExportSession = {
      id,
      status: 'pending',
      progress: 0,
      totalCount: 0,
      fetchedCount: 0,
      articles: [],
      cursor: null,
      startedAt: new Date(),
      auth
    };
    this.sessions.set(id, session);
    this.saveSessionToDisk(session);
    return id;
  }

  getSession(id: string): ExportSession | undefined {
    return this.sessions.get(id);
  }

  updateSession(id: string, updates: Partial<ExportSession>): void {
    const session = this.sessions.get(id);
    if (session) {
      const updatedSession = { ...session, ...updates };
      this.sessions.set(id, updatedSession);
      this.saveSessionToDisk(updatedSession);
    }
  }

  addArticles(id: string, articles: Article[]): void {
    const session = this.sessions.get(id);
    if (session) {
      session.articles.push(...articles);
      session.fetchedCount = session.articles.length;
      if (session.totalCount > 0) {
        session.progress = Math.round((session.fetchedCount / session.totalCount) * 100);
      }
      this.saveSessionToDisk(session);
    }
  }

  deleteSession(id: string): void {
    this.sessions.delete(id);
    this.deleteSessionFromDisk(id);
  }

  // Clean up old sessions (older than 24 hours)
  cleanupOldSessions(): void {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const [id, session] of this.sessions.entries()) {
      if (session.startedAt < oneDayAgo) {
        this.deleteSession(id);
      }
    }
  }
}

// Use global to persist the store across hot reloads in development
let exportStore: ExportStore;

if (process.env.NODE_ENV === 'production') {
  exportStore = new ExportStore();
} else {
  // In development, use a global variable to persist the store
  const globalWithStore = global as typeof globalThis & {
    __exportStore?: ExportStore;
  };
  
  if (!globalWithStore.__exportStore) {
    globalWithStore.__exportStore = new ExportStore();
  }
  
  exportStore = globalWithStore.__exportStore;
}

// Clean up old sessions every 30 minutes
if (typeof window === 'undefined') {
  setInterval(() => {
    exportStore.cleanupOldSessions();
  }, 30 * 60 * 1000);
}

export { exportStore };