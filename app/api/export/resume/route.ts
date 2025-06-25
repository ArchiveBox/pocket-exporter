import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';

export async function POST(request: NextRequest) {
  try {
    const { sessionId } = await request.json();

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

    // If the session was running or rate-limited, restart the export process
    if (session.status === 'running' || session.status === 'rate-limited') {
      // Import startExportProcess dynamically to avoid circular dependency
      const { startExportProcess } = await import('../start/route');
      
      // Reset rate limit status if needed
      if (session.status === 'rate-limited') {
        exportStore.updateSession(sessionId, {
          status: 'running',
          rateLimitedAt: undefined,
          rateLimitRetryAfter: undefined
        });
      }
      
      // Resume the export process
      startExportProcess(sessionId).catch((error) => {
        console.error('Resume export process error:', error);
        exportStore.updateSession(sessionId, { 
          status: 'error',
          error: error.message 
        });
      });
    }

    return NextResponse.json({
      success: true,
      session: {
        id: session.id,
        status: session.status,
        progress: session.progress,
        totalCount: session.totalCount,
        fetchedCount: session.fetchedCount,
        articles: exportStore.getSessionArticles(session.id),
        error: session.error,
        startedAt: session.startedAt,
        completedAt: session.completedAt
      }
    });

  } catch (error) {
    console.error('Resume session error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}