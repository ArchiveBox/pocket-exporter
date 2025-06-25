import fs from 'fs';
import path from 'path';

interface ImageInfo {
  path: string;
  size: number;
  extension: string;
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.tiff', '.gif'];
const MIN_SIZE = 16 * 1024; // 16KB
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

export async function findFallbackImages(articleDir: string): Promise<string[]> {
  const fallbackUrls: string[] = [];
  
  try {
    await fs.promises.access(articleDir);
  } catch (e) {
    return fallbackUrls;
  }

  try {
    const images: ImageInfo[] = [];
    
    // Recursively find all image files
    async function scanDirectory(dir: string) {
      const files = await fs.promises.readdir(dir);
      
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = await fs.promises.stat(filePath);
        
        if (stat.isDirectory()) {
          await scanDirectory(filePath);
        } else {
          const ext = path.extname(file).toLowerCase();
          if (IMAGE_EXTENSIONS.includes(ext) && stat.size > MIN_SIZE && stat.size < MAX_SIZE) {
            images.push({
              path: filePath,
              size: stat.size,
              extension: ext
            });
          }
        }
      }
    }
    
    await scanDirectory(articleDir);
    
    // Sort by size (largest first)
    images.sort((a, b) => b.size - a.size);
    
    // Convert to relative URLs for serving
    for (const image of images) {
      // Extract the relative path from the article directory
      const relativePath = path.relative(articleDir, image.path);
      fallbackUrls.push(relativePath);
    }
    
  } catch (error) {
    console.error(`Error scanning article directory ${articleDir}:`, error);
  }
  
  return fallbackUrls;
}

export async function enrichArticleWithFallbackImages(article: any, sessionId: string): Promise<any> {
  const articleDir = path.join(process.cwd(), 'sessions', sessionId, 'articles', article.savedId);
  const fallbackImages = await findFallbackImages(articleDir);
  
  return {
    ...article,
    fallbackImageUrls: fallbackImages.map(img => 
      `/api/article/image/${encodeURIComponent(img)}?session=${sessionId}&savedId=${article.savedId}`
    )
  };
}