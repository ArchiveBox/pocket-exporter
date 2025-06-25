import fs from 'fs';
import path from 'path';
import { Article } from '@/types/article';
import { enrichArticleWithFallbackImages } from './image-utils';

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


  private saveSessionToDisk(session: ExportSession): void {
    try {
      const sessionDir = path.join(this.sessionsDir, session.id);
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }
      const filePath = path.join(sessionDir, 'session.json');
      // Don't save articles array in session.json to keep it small
      const sessionData = { ...session };
      fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2));
    } catch (error) {
      console.error(`Failed to save session ${session.id} to disk:`, error);
    }
  }


  createSession(auth: { cookieString: string; headers: Record<string, string> }): string {
    const id = Math.random().toString(36).substring(2) + Date.now().toString(36);
    return this.createOrUpdateSession(id, auth);
  }
  
  createOrUpdateSession(id: string, auth: { cookieString: string; headers: Record<string, string> }, sessionUrl?: string): string {
    const outputDir = path.join(this.sessionsDir, id);
    const now = new Date();
    
    // Check if session already exists
    const existingSession = this.getSession(id);
    if (existingSession) {
      // Update auth but preserve existing session state
      existingSession.auth = auth;
      existingSession.lastModifiedAt = now;
      if (sessionUrl) {
        existingSession.sessionUrl = sessionUrl;
      }
      
      // Reset fetch task status but preserve the actual article count
      const currentArticleCount = this.getSessionArticleIds(id).length;
      existingSession.currentFetchTask = {
        status: 'idle',
        count: currentArticleCount,
        total: currentArticleCount,
        cursor: null
      };
      
      this.saveSessionToDisk(existingSession);
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
    this.saveSessionToDisk(session);
    return id;
  }

  getSession(id: string): ExportSession | undefined {
    // Always read from disk to ensure consistency
    const sessionPath = path.join(this.sessionsDir, id, 'session.json');
    if (fs.existsSync(sessionPath)) {
      try {
        const data = fs.readFileSync(sessionPath, 'utf8');
        const session = JSON.parse(data, (key, value) => {
          // Convert date strings back to Date objects
          if (key === 'createdAt' || key === 'lastModifiedAt' || key === 'startedAt' || 
              key === 'endedAt' || key === 'rateLimitedAt') {
            return value ? new Date(value) : value;
          }
          return value;
        });
        
        // Ensure all required fields are present with defaults
        const now = new Date();
        const articleCount = this.getSessionArticleIds(id).length;
        
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
      } catch (error) {
        console.error(`Failed to read session ${id} from disk:`, error);
      }
    }
    return undefined;
  }
  
  async getSessionArticlesAsync(id: string): Promise<Article[]> {
    // Use getSessionArticleIds to get valid article directories
    const articleIds = await this.getSessionArticleIdsAsync(id);
    const sessionDir = path.join(this.sessionsDir, id, 'articles');
    
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
          return enrichArticleWithFallbackImages(article, id);
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
  
  getSessionArticles(id: string): Article[] {
    // Keep synchronous version for backward compatibility
    // But this is the performance bottleneck!
    const articles: Article[] = [];
    
    // Use getSessionArticleIds to get valid article directories
    const articleIds = this.getSessionArticleIds(id);
    // console.log(`Found ${articleIds.length} valid articles for session ${id}`);
    
    const sessionDir = path.join(this.sessionsDir, id, 'articles');
    for (const articleId of articleIds) {
      try {
        const indexPath = path.join(sessionDir, articleId, 'index.json');
        const articleData = fs.readFileSync(indexPath, 'utf8');
        const article = JSON.parse(articleData);
        // Enrich article with fallback image URLs
        const enrichedArticle = enrichArticleWithFallbackImages(article, id);
        articles.push(enrichedArticle);
      } catch (error) {
        console.error(`Failed to load article ${articleId}:`, error);
      }
    }
    
    // console.log(`Loaded ${articles.length} articles from disk for session ${id}`);
    
    // Sort articles by creation date (newest first) to match UI expectation
    articles.sort((a, b) => b._createdAt - a._createdAt);
    
    return articles;
  }
  
  async getSessionArticleIdsAsync(id: string): Promise<string[]> {
    const sessionDir = path.join(this.sessionsDir, id, 'articles');
    
    try {
      await fs.promises.access(sessionDir);
    } catch {
      return [];
    }
    
    try {
      const dirs = await fs.promises.readdir(sessionDir);
      
      // Check directories in parallel
      const checks = await Promise.all(dirs.map(async (dir) => {
        if (dir.startsWith('.')) return null;
        
        const dirPath = path.join(sessionDir, dir);
        try {
          const stats = await fs.promises.stat(dirPath);
          if (stats.isDirectory()) {
            const indexPath = path.join(dirPath, 'index.json');
            try {
              await fs.promises.access(indexPath);
              return dir;
            } catch {
              return null;
            }
          }
        } catch {
          return null;
        }
        return null;
      }));
      
      // Filter out nulls and sort
      const articleIds = checks.filter((id): id is string => id !== null);
      articleIds.sort((a, b) => {
        const numA = parseInt(a, 10);
        const numB = parseInt(b, 10);
        return numB - numA;
      });
      
      return articleIds;
    } catch (error) {
      console.error(`Failed to get article IDs for session ${id}:`, error);
      return [];
    }
  }
  
  getSessionArticleIds(id: string): string[] {
    const sessionDir = path.join(this.sessionsDir, id, 'articles');
    const articleIds: string[] = [];
    
    if (fs.existsSync(sessionDir)) {
      try {
        const dirs = fs.readdirSync(sessionDir);
        for (const dir of dirs) {
          // Skip hidden files
          if (!dir.startsWith('.')) {
            const dirPath = path.join(sessionDir, dir);
            // Check if it's a directory AND contains index.json
            if (fs.statSync(dirPath).isDirectory()) {
              const indexPath = path.join(dirPath, 'index.json');
              if (fs.existsSync(indexPath)) {
                articleIds.push(dir);
              }
            }
          }
        }
        // Sort by integer value (largest to smallest)
        articleIds.sort((a, b) => {
          const numA = parseInt(a, 10);
          const numB = parseInt(b, 10);
          return numB - numA;
        });
      } catch (error) {
        console.error(`Failed to get article IDs for session ${id}:`, error);
      }
    }
    
    return articleIds;
  }

  updateSession(id: string, updates: Partial<ExportSession>): void {
    const session = this.getSession(id);
    if (session) {
      const updatedSession = { 
        ...session, 
        ...updates,
        lastModifiedAt: new Date()
      };
      this.saveSessionToDisk(updatedSession);
    }
  }
  
  updateFetchTask(id: string, updates: Partial<ExportSession['currentFetchTask']>): void {
    const session = this.getSession(id);
    if (session) {
      session.currentFetchTask = {
        ...session.currentFetchTask,
        ...updates
      };
      session.lastModifiedAt = new Date();
      this.saveSessionToDisk(session);
    }
  }
  
  updateDownloadTask(id: string, updates: Partial<ExportSession['currentDownloadTask']>): void {
    const session = this.getSession(id);
    if (session) {
      session.currentDownloadTask = {
        ...session.currentDownloadTask,
        ...updates
      };
      session.lastModifiedAt = new Date();
      this.saveSessionToDisk(session);
    }
  }

  deleteSession(id: string): boolean {
    const sessionDir = path.join(this.sessionsDir, id);
    
    if (!fs.existsSync(sessionDir)) {
      console.log(`Session directory not found: ${sessionDir}`);
      return false;
    }
    
    try {
      // Delete articles directory if it exists
      const articlesDir = path.join(sessionDir, 'articles');
      if (fs.existsSync(articlesDir)) {
        fs.rmSync(articlesDir, { recursive: true, force: true });
        console.log(`Deleted articles directory: ${articlesDir}`);
      }
      
      // Delete session.json if it exists
      const sessionFile = path.join(sessionDir, 'session.json');
      if (fs.existsSync(sessionFile)) {
        fs.unlinkSync(sessionFile);
        console.log(`Deleted session file: ${sessionFile}`);
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
