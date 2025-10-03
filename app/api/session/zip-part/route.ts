import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session');
    const part = parseInt(searchParams.get('part') || '1');

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

    // Get all article IDs
    const allArticleIds = await exportStore.getSessionArticleIds(sessionId);
    const ARTICLES_PER_ZIP = 10000;
    const totalParts = Math.ceil(allArticleIds.length / ARTICLES_PER_ZIP);

    if (part < 1 || part > totalParts) {
      return NextResponse.json(
        { error: `Invalid part number. Must be between 1 and ${totalParts}` },
        { status: 400 }
      );
    }

    // Calculate which articles go in this part
    const start = (part - 1) * ARTICLES_PER_ZIP;
    const end = Math.min(part * ARTICLES_PER_ZIP, allArticleIds.length);
    const articleIds = allArticleIds.slice(start, end);

    const sessionPath = path.join(process.cwd(), 'sessions', sessionId);

    // Create a ZIP file for this part
    const archive = archiver('zip', {
      zlib: { level: 1 } // Minimal compression for speed
    });

    // Set response headers
    const headers = new Headers();
    headers.set('Content-Type', 'application/zip');
    headers.set('Content-Disposition', `attachment; filename="pocket-export-${sessionId}-part${part}of${totalParts}.zip"`);
    headers.set('Cache-Control', 'no-cache, no-store');

    const stream = new ReadableStream({
      async start(controller) {
        try {
          archive.on('data', (chunk) => {
            controller.enqueue(new Uint8Array(chunk));
          });

          archive.on('end', () => {
            console.log(`ZIP part ${part} completed for session ${sessionId}`);
            controller.close();
          });

          archive.on('error', (err) => {
            console.error('Archive error:', err);
            controller.error(err);
          });

          // Add session.json and payment.json to first part only
          if (part === 1) {
            const sessionJsonPath = path.join(sessionPath, 'session.json');
            if (fs.existsSync(sessionJsonPath)) {
              archive.file(sessionJsonPath, { name: 'session.json' });
            }
            
            const paymentJsonPath = path.join(sessionPath, 'payment.json');
            if (fs.existsSync(paymentJsonPath)) {
              archive.file(paymentJsonPath, { name: 'payment.json' });
            }
          }

          // Add only the articles for this part
          const articlesPath = path.join(sessionPath, 'articles');
          let processed = 0;
          
          for (const articleId of articleIds) {
            const articleDir = path.join(articlesPath, articleId);
            
            // Check if directory exists before adding
            try {
              await fs.promises.access(articleDir);
              archive.directory(articleDir, `articles/${articleId}`);
              
              processed++;
              if (processed % 1000 === 0) {
                console.log(`Part ${part}: processed ${processed}/${articleIds.length} articles`);
              }
            } catch (e) {
              // Skip missing articles
            }
          }

          // Add a manifest file
          const manifest = {
            part,
            totalParts,
            sessionId,
            articlesInThisPart: articleIds.length,
            articleRange: `${start + 1}-${end}`,
            totalArticles: allArticleIds.length,
            created: new Date().toISOString()
          };
          
          archive.append(JSON.stringify(manifest, null, 2), { 
            name: `manifest-part${part}.json` 
          });

          await archive.finalize();
        } catch (error) {
          console.error('Stream error:', error);
          controller.error(error);
        }
      },
      cancel() {
        archive.abort();
      }
    });

    return new NextResponse(stream, { headers });

  } catch (error) {
    console.error('Download session ZIP part error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}