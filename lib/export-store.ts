import fs from 'fs';
import path from 'path';
import { Article } from '@/types/article';
import { enrichArticleWithFallbackImages } from './image-utils';
import { atomicWriteJson, readJsonFile } from './atomic-write';
import { getArticleDir } from './helpers';

interface ExportSession {
  id: string; // session id based on pocket consumer key
  outputDir: string; // directory to save the output to
  createdAt: Date;
  lastModifiedAt: Date;
  sessionUrl: string;
  
  // Authentication
  auth: {
    cookieString: string;
    headers: Record<string, string>;
  };
  
  currentDownloadTask: {
    status: 'idle' | 'running' | 'completed' | 'stopped' | 'error';
    count: number;
    total: number;
    startedAt?: Date;
    endedAt?: Date;
    currentID?: string; // article savedId of current item being processed
    pid?: number; // pid of the subprocess
    rateLimitedAt?: Date;
    rateLimitRetryAfter?: number;
    cursor?: string;
    error?: string;
  };
  
  currentFetchTask: {
    status: 'idle' | 'running' | 'completed' | 'stopped' | 'error';
    count: number;
    total: number;
    startedAt?: Date;
    endedAt?: Date;
    currentID?: string; // article savedId of current item being processed
    pid?: number;
    rateLimitedAt?: Date;
    rateLimitRetryAfter?: number;
    cursor?: string;
    error?: string;
    rateLimitState?: {
      requestTimes: number[]; // Rolling buffer of last 100 request timestamps
    };
  };
}


class ExportStore {
  private sessionsDir = path.join(process.cwd(), 'sessions');

  constructor() {
    // Ensure sessions directory exists
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }


  private async saveSessionToDisk(session: ExportSession): Promise<void> {
    try {
      const sessionDir = path.join(this.sessionsDir, session.id);
      await fs.promises.mkdir(sessionDir, { recursive: true });
      const filePath = path.join(sessionDir, 'session.json');
      // Don't save articles array in session.json to keep it small
      const sessionData = { ...session };
      await atomicWriteJson(filePath, sessionData);
    } catch (error) {
      console.error(`Failed to save session ${session.id} to disk:`, error);
    }
  }


  async createSession(auth: { cookieString: string; headers: Record<string, string> }): Promise<string> {
    const id = Math.random().toString(36).substring(2) + Date.now().toString(36);
    return this.createOrUpdateSession(id, auth);
  }
  
  async createOrUpdateSession(id: string, auth: { cookieString: string; headers: Record<string, string> }, sessionUrl?: string): Promise<string> {
    const outputDir = path.join(this.sessionsDir, id);
    const now = new Date();
    
    // Check if session already exists
    const existingSession = await this.getSession(id);
    if (existingSession) {
      // Update auth but preserve existing session state
      existingSession.auth = auth;
      existingSession.lastModifiedAt = now;
      if (sessionUrl) {
        existingSession.sessionUrl = sessionUrl;
      }
      
      // Reset fetch task status but preserve the actual article count and cursor
      const currentArticleCount = (await this.getSessionArticleIds(id)).length;
      existingSession.currentFetchTask = {
        status: 'idle',
        count: currentArticleCount,
        total: currentArticleCount,
        cursor: existingSession.currentFetchTask?.cursor || null
      };
      
      await this.saveSessionToDisk(existingSession);
      return id;
    }
    
    // Create new session with the new structure
    const session: ExportSession = {
      id,
      createdAt: now,
      lastModifiedAt: now,
      sessionUrl: sessionUrl || `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?session=${id}`,
      outputDir,
      auth,
      currentFetchTask: {
        status: 'idle',
        count: 0,
        total: 0,
        cursor: null
      },
      currentDownloadTask: {
        status: 'idle',
        count: 0,
        total: 0
      }
    };
    await this.saveSessionToDisk(session);
    return id;
  }

  async getSession(id: string): Promise<ExportSession | undefined> {
    // Always read from disk to ensure consistency
    const sessionPath = path.join(this.sessionsDir, id, 'session.json');
    try {
      const session = await readJsonFile<ExportSession>(sessionPath);
      if (!session) {
        return undefined;
      }
      
      // Convert date strings back to Date objects and fix corrupted ones
      const dateFields = ['createdAt', 'lastModifiedAt', 'startedAt', 'endedAt', 'rateLimitedAt'];
      const convertDates = (obj: any, path: string[] = []): any => {
        if (!obj || typeof obj !== 'object') return obj;
        
        for (const key in obj) {
          // Check if this key is a date field anywhere in the object
          if (dateFields.includes(key) && obj[key]) {
            // Check if it's a corrupted date object (has numeric keys like "0", "1", etc.)
            if (typeof obj[key] === 'object' && '0' in obj[key]) {
              console.log(`Fixing corrupted date at ${[...path, key].join('.')}, replacing with current time`);
              obj[key] = new Date();
            } else {
              // Normal conversion
              obj[key] = new Date(obj[key]);
            }
          } else if (typeof obj[key] === 'object' && obj[key] !== null && !(obj[key] instanceof Date)) {
            obj[key] = convertDates(obj[key], [...path, key]);
          }
        }
        return obj;
      };
      
      convertDates(session);
        
        // Ensure all required fields are present with defaults
        const now = new Date();
        const articleCount = (await this.getSessionArticleIds(id)).length;
        
        // Ensure currentFetchTask exists
        if (!session.currentFetchTask) {
          session.currentFetchTask = {
            status: 'completed',
            count: articleCount,
            total: articleCount,
            cursor: null
          };
        }
        
        // Ensure currentDownloadTask exists
        if (!session.currentDownloadTask) {
          session.currentDownloadTask = {
            status: 'idle',
            count: 0,
            total: articleCount
          };
        }
        
        // Ensure other required fields
        if (!session.createdAt) {
          session.createdAt = session.lastModifiedAt || now;
        }
        
        if (!session.sessionUrl) {
          session.sessionUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}?session=${id}`;
        }
        
        if (!session.outputDir) {
          session.outputDir = path.join(this.sessionsDir, id);
        }
        
        return session;
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          console.error(`Failed to read session ${id} from disk:`, error);
        }
      }
    return undefined;
  }
  
  async getSessionArticles(id: string): Promise<Article[]> {
    // Use getSessionArticleIds to get valid article directories
    const articleIds = await this.getSessionArticleIds(id);
    return this.getArticlesById(id, articleIds);
  }
  
  async getArticlesById(sessionId: string, articleIds: string[]): Promise<Article[]> {
    const sessionDir = path.join(this.sessionsDir, sessionId, 'articles');
    
    // Load articles in parallel batches to avoid overwhelming file system
    const BATCH_SIZE = 100;
    const articles: Article[] = [];
    
    for (let i = 0; i < articleIds.length; i += BATCH_SIZE) {
      const batch = articleIds.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (articleId) => {
        try {
          const indexPath = path.join(sessionDir, articleId, 'index.json');
          const articleData = await fs.promises.readFile(indexPath, 'utf8');
          const article = JSON.parse(articleData);
          return await enrichArticleWithFallbackImages(article, sessionId);
        } catch (error) {
          console.error(`Failed to load article ${articleId}:`, error);
          return null;
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      articles.push(...batchResults.filter((a): a is Article => a !== null));
    }
    
    // Sort articles by creation date (newest first) to match UI expectation
    articles.sort((a, b) => b._createdAt - a._createdAt);
    
    return articles;
  }
  
  
  async getSessionArticleIds(id: string, filterQuery?: string): Promise<string[]> {
    const sessionDir = path.join(this.sessionsDir, id, 'articles');
    
    try {
      await fs.promises.access(sessionDir);
    } catch {
      return [];
    }
    
    try {
      const dirs = await fs.promises.readdir(sessionDir);
      
      // If no filter, just return directory names that look like article IDs
      if (!filterQuery) {
        // Simply filter directories that are numeric (article IDs)
        const articleIds = dirs.filter(dir => !dir.startsWith('.') && /^\d+$/.test(dir));
        
        // Sort numerically
        articleIds.sort((a, b) => {
          const numA = parseInt(a, 10);
          const numB = parseInt(b, 10);
          return numB - numA;
        });
        
        return articleIds;
      }
      
      // With filter, we need to load and check each article
      const query = filterQuery.toLowerCase();
      const BATCH_SIZE = 100;
      const matchingIds: string[] = [];
      
      // Process in batches to avoid overwhelming the file system
      for (let i = 0; i < dirs.length; i += BATCH_SIZE) {
        const batch = dirs.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (dir) => {
          if (dir.startsWith('.')) return null;
          
          const dirPath = path.join(sessionDir, dir);
          try {
            const stats = await fs.promises.stat(dirPath);
            if (!stats.isDirectory()) return null;
            
            const indexPath = path.join(dirPath, 'index.json');
            const articleData = await fs.promises.readFile(indexPath, 'utf8');
            const article = JSON.parse(articleData);
            
            // Search in title, URL, and tags
            if (article.title?.toLowerCase().includes(query) ||
                article.url?.toLowerCase().includes(query) ||
                article.tags?.some((tag: any) => tag.name?.toLowerCase().includes(query))) {
              return dir;
            }
          } catch {
            // Skip on error
          }
          return null;
        });
        
        const batchResults = await Promise.all(batchPromises);
        matchingIds.push(...batchResults.filter((id): id is string => id !== null));
      }
      
      // Sort matching IDs
      matchingIds.sort((a, b) => {
        const numA = parseInt(a, 10);
        const numB = parseInt(b, 10);
        return numB - numA;
      });
      
      return matchingIds;
    } catch (error) {
      console.error(`Failed to get article IDs for session ${id}:`, error);
      return [];
    }
  }
  

  async updateSession(id: string, updates: Partial<ExportSession>): Promise<void> {
    const session = await this.getSession(id);
    if (session) {
      const updatedSession = { 
        ...session, 
        ...updates,
        lastModifiedAt: new Date()
      };
      await this.saveSessionToDisk(updatedSession);
    }
  }
  
  async updateFetchTask(id: string, updates: Partial<ExportSession['currentFetchTask']>): Promise<void> {
    const sessionPath = path.join(this.sessionsDir, id, 'session.json');
    
    // Check if session exists
    const exists = await fs.promises.access(sessionPath).then(() => true).catch(() => false);
    if (!exists) {
      return;
    }
    
    // Use atomic merge write to handle concurrent updates
    await atomicWriteJson(
      sessionPath,
      {
        currentFetchTask: updates,
        lastModifiedAt: new Date()
      },
      { merge: true }
    );
  }
  
  async updateDownloadTask(id: string, updates: Partial<ExportSession['currentDownloadTask']>): Promise<void> {
    const sessionPath = path.join(this.sessionsDir, id, 'session.json');
    
    // Check if session exists
    const exists = await fs.promises.access(sessionPath).then(() => true).catch(() => false);
    if (!exists) {
      return;
    }
    
    // Use atomic merge write to handle concurrent updates
    await atomicWriteJson(
      sessionPath,
      {
        currentDownloadTask: updates,
        lastModifiedAt: new Date()
      },
      { merge: true }
    );
  }

  async deleteSession(id: string): Promise<boolean> {
    const sessionDir = path.join(this.sessionsDir, id);
    
    try {
      await fs.promises.access(sessionDir);
    } catch {
      console.log(`Session directory not found: ${sessionDir}`);
      return false;
    }
    
    try {
      // Delete articles directory if it exists
      const articlesDir = path.join(sessionDir, 'articles');
      try {
        await fs.promises.rm(articlesDir, { recursive: true, force: true });
        console.log(`Deleted articles directory: ${articlesDir}`);
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      
      // Delete session.json if it exists
      const sessionFile = path.join(sessionDir, 'session.json');
      try {
        await fs.promises.unlink(sessionFile);
        console.log(`Deleted session file: ${sessionFile}`);
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      
      // Preserve payments.json by not deleting it
      console.log(`Preserved payment data for session ${id}`);
      
      return true;
    } catch (error) {
      console.error(`Failed to delete session ${id}:`, error);
      return false;
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


export { exportStore };
