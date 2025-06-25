import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import fs from 'fs';
import path from 'path';
import { withTiming } from '@/lib/with-timing';

export const DELETE = withTiming(async (request: NextRequest) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session');

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    // Check if session exists
    const session = await exportStore.getSession(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Stop any running tasks
    if (session.currentFetchTask?.status === 'running') {
      await exportStore.updateFetchTask(sessionId, {
        status: 'stopped',
        endedAt: new Date()
      });
    }

    if (session.currentDownloadTask?.status === 'running') {
      await exportStore.updateDownloadTask(sessionId, {
        status: 'stopped',
        endedAt: new Date()
      });
    }

    // Delete session using the export store
    const deleted = await exportStore.deleteSession(sessionId);
    
    if (!deleted) {
      return NextResponse.json(
        { error: 'Failed to delete session directory' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: `Session ${sessionId} and all associated data has been deleted`
    });

  } catch (error) {
    console.error('Delete session error:', error);
    return NextResponse.json(
      { error: 'Failed to delete session' },
      { status: 500 }
    );
  }
});