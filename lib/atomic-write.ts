import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { deepMerge } from './helpers';

interface WriteOptions {
  merge?: boolean;
  retries?: number;
}

/**
 * Get file stats including mtime for change detection
 */
async function getFileMtime(filePath: string): Promise<Date | null> {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.mtime;
  } catch (error) {
    return null;
  }
}

/**
 * Atomically write data to a file by writing to a temporary file first
 * and then renaming it to the target path. This prevents partial writes
 * and corruption when multiple processes write to the same file.
 * 
 * If merge is true, it will detect concurrent modifications and merge changes.
 */
export async function atomicWriteJson(
  filePath: string, 
  data: any, 
  options: WriteOptions = {}
): Promise<void> {
  const { merge = false, retries = 3 } = options;
  
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  
  let attempt = 0;
  let lastError: Error | null = null;
  
  while (attempt < retries) {
    attempt++;
    
    // Create a unique temporary filename in the same directory
    const tempId = crypto.randomBytes(8).toString('hex');
    const tempPath = path.join(dir, `.${basename}.${tempId}.tmp`);
    
    try {
      // Ensure directory exists
      await fs.promises.mkdir(dir, { recursive: true });
      
      // If merging is enabled, handle concurrent modifications
      if (merge) {
        // Get the current file mtime before reading
        const mtimeBefore = await getFileMtime(filePath);
        
        // Read current data if file exists
        let currentData: any = null;
        try {
          const fileContent = await fs.promises.readFile(filePath, 'utf8');
          currentData = JSON.parse(fileContent);
        } catch (e) {
          // File doesn't exist or is invalid, proceed with new data
        }
        
        // If file exists, merge the data
        let finalData = data;
        if (currentData !== null) {
          finalData = deepMerge(currentData, data);
        }
        
        // Write to temporary file
        const jsonString = JSON.stringify(finalData, null, 2);
        await fs.promises.writeFile(tempPath, jsonString, 'utf8');
        
        // Check if file was modified while we were processing
        const mtimeAfter = await getFileMtime(filePath);
        
        // If file was modified (mtime changed), retry
        if (mtimeBefore && mtimeAfter && mtimeBefore.getTime() !== mtimeAfter.getTime()) {
          // Clean up temp file
          await fs.promises.unlink(tempPath).catch(() => {});
          
          if (attempt < retries) {
            // Add a small random delay to avoid thundering herd
            await new Promise(resolve => setTimeout(resolve, Math.random() * 100));
            continue;
          } else {
            throw new Error('File was modified during write operation');
          }
        }
      } else {
        // Simple write without merging
        const jsonString = JSON.stringify(data, null, 2);
        await fs.promises.writeFile(tempPath, jsonString, 'utf8');
      }
      
      // Atomically rename temp file to target
      // On POSIX systems, rename is atomic
      await fs.promises.rename(tempPath, filePath);
      
      // Success, exit the retry loop
      return;
      
    } catch (error) {
      // Clean up temp file if it exists
      try {
        await fs.promises.unlink(tempPath);
      } catch (e) {
        // Ignore cleanup errors
      }
      
      lastError = error as Error;
      
      // If this was the last attempt, throw the error
      if (attempt >= retries) {
        throw lastError;
      }
      
      // Add a small random delay before retry
      await new Promise(resolve => setTimeout(resolve, Math.random() * 100));
    }
  }
  
  // Should never reach here, but throw last error just in case
  throw lastError || new Error('Unknown error in atomicWriteJson');
}

/**
 * Read JSON file with proper error handling
 */
export async function readJsonFile<T = any>(filePath: string): Promise<T | null> {
  try {
    const data = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}