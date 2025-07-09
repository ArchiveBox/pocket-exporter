import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { withTiming } from '@/lib/with-timing';

// Disable Next.js buffering for this route to enable true streaming
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = withTiming(async (request: NextRequest) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session');

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    const session = await exportStore.getSession(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    const sessionPath = path.join(process.cwd(), 'sessions', sessionId);
    try {
      await fs.promises.access(sessionPath);
    } catch (e) {
      return NextResponse.json(
        { error: 'Session directory not found' },
        { status: 404 }
      );
    }

    // Create a ZIP file containing all exported data
    const archive = archiver('zip', {
      zlib: { level: 6 } // Reduced compression for faster streaming
    });

    // Set response headers for ZIP download
    const headers = new Headers();
    headers.set('Content-Type', 'application/zip');
    headers.set('Content-Disposition', `attachment; filename="pocket-export-${sessionId}.zip"`);
    headers.set('Cache-Control', 'no-cache, no-store');
    headers.set('X-Content-Type-Options', 'nosniff');

    // Create a more robust stream implementation
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Set up archive event handlers
          archive.on('data', (chunk) => {
            try {
              controller.enqueue(new Uint8Array(chunk));
            } catch (e) {
              console.error('Error enqueueing chunk:', e);
            }
          });

          archive.on('end', () => {
            console.log(`ZIP stream completed for session ${sessionId}`);
            controller.close();
          });

          archive.on('error', (err) => {
            console.error('Archive error:', err);
            controller.error(err);
          });

          archive.on('warning', (err) => {
            console.warn('Archive warning:', err);
          });

          // Add progress logging - only log every 5000 files
          archive.on('progress', (progress) => {
            if (progress.entries.processed % 5000 === 0) {
              console.log(`ZIP progress for ${sessionId}: ${progress.entries.processed} files processed`);
            }
          });

          // Add all files from the session directory
          // Use false to not include the sessionId directory itself
          archive.directory(sessionPath, false);

          // Finalize the archive
          await archive.finalize();
        } catch (error) {
          console.error('Stream start error:', error);
          controller.error(error);
        }
      },
      cancel() {
        // Abort the archive if the stream is cancelled
        archive.abort();
        console.log(`ZIP stream cancelled for session ${sessionId}`);
      }
    });

    return new NextResponse(stream, { headers });

  } catch (error) {
    console.error('Download session ZIP error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
});