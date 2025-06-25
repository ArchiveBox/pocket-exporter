import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { withTiming } from '@/lib/with-timing';

export const GET = withTiming(async (
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session');
    const savedId = searchParams.get('savedId');
    const { filename } = await params;

    if (!sessionId || !savedId || !filename) {
      return NextResponse.json(
        { error: 'Session ID, savedId, and filename are required' },
        { status: 400 }
      );
    }

    // Sanitize filename to prevent directory traversal
    const sanitizedFilename = path.basename(filename);
    
    const imagePath = path.join(
      process.cwd(),
      'sessions',
      sessionId,
      'articles',
      savedId,
      sanitizedFilename
    );

    // Ensure the path is within the article directory
    const articleDir = path.join(process.cwd(), 'sessions', sessionId, 'articles', savedId);
    if (!imagePath.startsWith(articleDir)) {
      return NextResponse.json(
        { error: 'Invalid file path' },
        { status: 403 }
      );
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = await fs.promises.readFile(imagePath);
    } catch (e) {
      return NextResponse.json(
        { error: 'Image not found' },
        { status: 404 }
      );
    }
    const ext = path.extname(sanitizedFilename).toLowerCase();
    
    // Map file extensions to MIME types
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.tiff': 'image/tiff',
      '.bmp': 'image/bmp'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';

    return new NextResponse(imageBuffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });

  } catch (error) {
    console.error('Get article image error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
});