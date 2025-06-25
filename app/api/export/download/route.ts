import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('sessionId');
    const format = searchParams.get('format') || 'zip'; // zip or json

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    const session = exportStore.getSession(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    const sessionPath = path.join(process.cwd(), 'sessions', sessionId);
    if (!fs.existsSync(sessionPath)) {
      return NextResponse.json(
        { error: 'Session directory not found' },
        { status: 404 }
      );
    }

    if (format === 'json') {
      // Use exportStore to get all articles
      const articles = exportStore.getSessionArticles(sessionId);
      
      return new NextResponse(JSON.stringify(articles, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="pocket-export-${sessionId}.json"`,
        },
      });
    } else {
      // Create a ZIP file containing all exported data
      const archive = archiver('zip', {
        zlib: { level: 9 } // Maximum compression
      });

      // Set response headers for ZIP download
      const headers = new Headers();
      headers.set('Content-Type', 'application/zip');
      headers.set('Content-Disposition', `attachment; filename="pocket-export-${sessionId}.zip"`);

      // Create a stream for the response
      const stream = new ReadableStream({
        async start(controller) {
          archive.on('data', (chunk) => {
            controller.enqueue(chunk);
          });

          archive.on('end', () => {
            controller.close();
          });

          archive.on('error', (err) => {
            controller.error(err);
          });

          // Add all files from the session directory
          archive.directory(sessionPath, false);

          // Finalize the archive
          await archive.finalize();
        },
      });

      return new NextResponse(stream, { headers });
    }
  } catch (error) {
    console.error('Download error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}