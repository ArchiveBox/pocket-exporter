import fs from 'fs';
import path from 'path';

// Simple cache to avoid constant file system reads
const sizeCache = new Map<string, { size: number; timestamp: number }>();
const CACHE_TTL = 10000; // 10 seconds

export function getSessionSizeInMB(sessionId: string): number {
  // Check cache first
  const cached = sizeCache.get(sessionId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.size;
  }

  const sessionDir = path.join(process.cwd(), 'sessions', sessionId);
  
  if (!fs.existsSync(sessionDir)) {
    return 0;
  }

  let totalSize = 0;

  function calculateDirSize(dirPath: string) {
    try {
      const files = fs.readdirSync(dirPath);
      
      for (const file of files) {
        // Skip system files
        if (file.startsWith('.')) continue;
        
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        
        if (stats.isDirectory()) {
          calculateDirSize(filePath);
        } else {
          totalSize += stats.size;
        }
      }
    } catch (error) {
      // Ignore errors from concurrent file operations
    }
  }

  calculateDirSize(sessionDir);
  
  // Convert bytes to MB
  const sizeInMB = totalSize / (1024 * 1024);
  
  // Cache the result
  sizeCache.set(sessionId, { size: sizeInMB, timestamp: Date.now() });
  
  return sizeInMB;
}