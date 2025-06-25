import fs from 'fs';
import path from 'path';
import { Article } from '@/types/article';
import { enrichArticleWithFallbackImages } from './image-utils';

// Import common helpers
const { deepMerge, isObject, getArticleDir } = require('../helpers');

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
  
  getSessionArticles(id: string): Article[] {
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

  addArticles(id: string, articles: Article[]): void {
    const session = this.getSession(id);
    if (session) {
      // Save articles to disk
      this.saveArticlesToDisk(session, articles);
      
      // Get the current total count from disk
      const currentArticleCount = this.getSessionArticleIds(id).length;
      
      // Update fetch task count with the actual count from disk
      session.currentFetchTask.count = currentArticleCount;
      session.lastModifiedAt = new Date();
      
      // Update session file
      this.saveSessionToDisk(session);
    }
  }

  private saveArticlesToDisk(session: ExportSession, newArticles: Article[]): string[] {
    const newArticleIds: string[] = [];
    
    try {
      const sessionDir = path.join(this.sessionsDir, session.id);
      const articlesDir = path.join(sessionDir, 'articles');
      
      // Save each article in its own directory
      newArticles.forEach(article => {
        const articleDir = path.join(articlesDir, article.savedId);
        const isNewArticle = !fs.existsSync(articleDir);
        
        if (!fs.existsSync(articleDir)) {
          fs.mkdirSync(articleDir, { recursive: true });
        }
        
        // Deep merge with existing article if it exists
        const indexPath = path.join(articleDir, 'index.json');
        let mergedArticle = article;
        
        if (fs.existsSync(indexPath)) {
          try {
            const existingArticle = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            // Deep merge: new data overwrites old data
            mergedArticle = deepMerge(existingArticle, article);
          } catch (error) {
            console.error(`Failed to merge article ${article.savedId}:`, error);
          }
        }
        
        fs.writeFileSync(indexPath, JSON.stringify(mergedArticle, null, 2));
        
        // Track only truly new articles
        if (isNewArticle) {
          newArticleIds.push(article.savedId);
        }
        
        // TODO: Later we can add article.html, images, etc. here
      });
      
      // No need for separate metadata.json anymore
      
      // Create a simple articles.json with just the list of article IDs for quick reference
      const articlesListPath = path.join(sessionDir, 'articles.json');
      const articleIds = fs.existsSync(articlesDir) 
        ? fs.readdirSync(articlesDir).filter(dir => fs.statSync(path.join(articlesDir, dir)).isDirectory())
        : [];
      fs.writeFileSync(articlesListPath, JSON.stringify(articleIds, null, 2));
    } catch (error) {
      console.error(`Failed to save articles to disk for session ${session.id}:`, error);
    }
    
    return newArticleIds;
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
