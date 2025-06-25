import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';

export async function POST(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session');

    if (!sessionId) {
      return NextResponse.json(
        { success: false, error: 'Session ID is required' },
        { status: 400 }
      );
    }

    const session = exportStore.getSession(sessionId);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Session not found' },
        { status: 404 }
      );
    }

    // Update fetch task status to stopped
    exportStore.updateFetchTask(sessionId, {
      status: 'stopped',
      endedAt: new Date()
    });

    console.log(`Stopped fetch task for session ${sessionId}`);

    return NextResponse.json({ 
      success: true 
    });

  } catch (error) {
    console.error('Stop fetch task error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}