import { NextRequest } from 'next/server';
import { exportStore } from '@/lib/export-store';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { PassThrough } from 'stream';
import { Readable } from 'stream';

// Disable Next.js buffering for this route to enable true streaming
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session');

    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'Session ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const session = await exportStore.getSession(sessionId);
    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const sessionPath = path.join(process.cwd(), 'sessions', sessionId);
    try {
      await fs.promises.access(sessionPath);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Session directory not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create a PassThrough stream with larger buffer
    const passThrough = new PassThrough({
      highWaterMark: 16 * 1024 * 1024 // 16MB buffer
    });
    
    // Create archive with optimized settings for speed
    const archive = archiver('zip', {
      zlib: { level: 0 }, // No compression - store only
      highWaterMark: 16 * 1024 * 1024, // 16MB chunks
      statConcurrency: 32 // Process more files in parallel
    });

    // Pipe archive to passthrough
    archive.pipe(passThrough);

    // Handle archive events
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      passThrough.destroy(err);
    });

    archive.on('warning', (err) => {
      console.warn('Archive warning:', err);
    });

    archive.on('progress', (progress) => {
      // Log progress every 5000 files instead of every 100
      if (progress.entries.processed % 5000 === 0) {
        console.log(`ZIP progress for ${sessionId}: ${progress.entries.processed}/${progress.entries.total} files`);
      }
    });

    // Start archiving process
    setImmediate(async () => {
      try {
        // Add all files from the session directory
        archive.directory(sessionPath, false);
        
        // Finalize the archive
        await archive.finalize();
        console.log(`Archive finalized for session ${sessionId}`);
      } catch (error) {
        console.error('Archive error:', error);
        passThrough.destroy(error as Error);
      }
    });

    // Convert Node.js stream to Web Stream
    const webStream = Readable.toWeb(passThrough) as ReadableStream<Uint8Array>;

    // Return response with proper headers
    return new Response(webStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="pocket-export-${sessionId}.zip"`,
        'Cache-Control': 'no-cache, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Transfer-Encoding': 'chunked'
      }
    });

  } catch (error) {
    console.error('Download session ZIP error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}