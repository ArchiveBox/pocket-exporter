import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import { getDownloadStatus } from '@/lib/article-downloader';
import { getSessionSizeInMB } from '@/lib/session-utils';
import { execSync } from 'child_process';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('sessionId');
    const lastFetchedCount = searchParams.get('lastFetchedCount');

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    let session = exportStore.getSession(sessionId);

    if (!session) {
      console.error('Session not found:', sessionId);
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Always return the full list of articles from disk
    const allArticles = exportStore.getSessionArticles(sessionId);

    // Check if download task process is actually running
    if (session.currentDownloadTask && 
        session.currentDownloadTask.status === 'running' && 
        session.currentDownloadTask.pid) {
      try {
        // Check if process exists (kill -0 just checks, doesn't actually kill)
        execSync(`kill -0 ${session.currentDownloadTask.pid}`, { stdio: 'ignore' });
      } catch (error) {
        // Process doesn't exist, update task status to stopped
        console.log(`Download process ${session.currentDownloadTask.pid} not found, updating status to stopped`);
        exportStore.updateDownloadTask(sessionId, {
          status: 'stopped',
          endedAt: new Date(),
          currentID: undefined
        });
        // Refresh session data
        session = exportStore.getSession(sessionId)!;
      }
    }
    
    // Check if fetch task process is actually running
    if (session.currentFetchTask && 
        session.currentFetchTask.status === 'running' && 
        session.currentFetchTask.pid) {
      try {
        execSync(`kill -0 ${session.currentFetchTask.pid}`, { stdio: 'ignore' });
      } catch (error) {
        // Process doesn't exist, update task status to stopped
        console.log(`Fetch process ${session.currentFetchTask.pid} not found, updating status to stopped`);
        exportStore.updateFetchTask(sessionId, {
          status: 'stopped',
          endedAt: new Date(),
          currentID: undefined
        });
        // Refresh session data
        session = exportStore.getSession(sessionId)!;
      }
    }
    
    const downloadStatus = getDownloadStatus(sessionId, allArticles);
    const sessionSizeMB = getSessionSizeInMB(sessionId);
    
    // Debug logging
    // console.log(`Status endpoint: returning ${allArticles.length} total articles for session ${sessionId}`);
    // if (downloadStatus.total > 0) {
      // console.log(`Download status for ${sessionId}: ${downloadStatus.completed}/${downloadStatus.total} completed`);
    // }
    
    // Return session.json almost verbatim with articles added
    return NextResponse.json({
      ...session,
      articles: allArticles,
      downloadStatus,
      sessionSizeMB
    });

  } catch (error) {
    console.error('Get status error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
