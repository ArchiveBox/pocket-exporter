import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import { getDownloadStatus } from '@/lib/article-downloader';
import { getSessionSizeInMB, readPaymentData, updatePaymentData } from '@/lib/session-utils';
import { stripe } from '@/lib/stripe';
import { execSync } from 'child_process';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session');
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
    let paymentData = readPaymentData(sessionId);
    
    // Only check and sync payment status with Stripe if payment is not already completed
    if (paymentData?.payment?.stripeSessionId && paymentData.payment.status !== 'completed') {
      console.log(`Checking payment status for session ${sessionId}, current status: ${paymentData.payment.status}`);
      try {
        const stripeSession = await stripe.checkout.sessions.retrieve(
          paymentData.payment.stripeSessionId
        );
        
        console.log(`Stripe session ${paymentData.payment.stripeSessionId} status: ${stripeSession.status}, payment_status: ${stripeSession.payment_status}, payment_intent: ${stripeSession.payment_intent}`);
        
        // Check both session status and payment status
        let isPaymentComplete = stripeSession.status === 'complete' || 
                               stripeSession.payment_status === 'paid';
        
        // Always check the payment intent if available
        if (stripeSession.payment_intent && !isPaymentComplete) {
          try {
            const paymentIntent = await stripe.paymentIntents.retrieve(stripeSession.payment_intent as string);
            console.log(`Payment intent ${paymentIntent.id} status: ${paymentIntent.status}`);
            
            if (paymentIntent.status === 'succeeded' && paymentData.payment.status !== 'completed') {
              console.log(`Payment intent succeeded, updating payment status for session ${sessionId}`);
              
              let chargeData = {};
              // Retrieve charge information
              if (paymentIntent.latest_charge) {
                try {
                  const charge = await stripe.charges.retrieve(paymentIntent.latest_charge as string);
                  chargeData = {
                    stripeChargeId: charge.id,
                    receiptUrl: charge.receipt_url,
                    receiptEmail: charge.receipt_email,
                    customerId: charge.customer as string
                  };
                  console.log(`Retrieved charge ${charge.id} for verification`);
                } catch (chargeError) {
                  console.error('Error retrieving charge:', chargeError);
                }
              }
              
              paymentData = updatePaymentData(sessionId, {
                hasUnlimitedAccess: true,
                payment: {
                  ...paymentData.payment,
                  status: 'completed',
                  stripePaymentIntentId: paymentIntent.id,
                  amount: paymentIntent.amount || stripeSession.amount_total || 0,
                  currency: paymentIntent.currency || stripeSession.currency || 'usd',
                  completedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  ...chargeData
                }
              });
              console.log(`Payment verified via payment intent and updated for session ${sessionId}`);
            }
          } catch (piError) {
            console.error('Error checking payment intent:', piError);
          }
        } else if (isPaymentComplete && paymentData.payment.status !== 'completed') {
          console.log(`Updating payment status to completed for session ${sessionId}`);
          paymentData = updatePaymentData(sessionId, {
            hasUnlimitedAccess: true,
            payment: {
              ...paymentData.payment,
              status: 'completed',
              stripePaymentIntentId: stripeSession.payment_intent as string,
              amount: stripeSession.amount_total || 0,
              currency: stripeSession.currency || 'usd',
              completedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          });
          console.log(`Payment verified and updated for session ${sessionId}`);
        }
      } catch (error) {
        console.error('Error checking Stripe payment status:', error);
      }
    }
    
    // Debug logging
    // console.log(`Status endpoint: returning ${allArticles.length} total articles for session ${sessionId}`);
    // if (downloadStatus.total > 0) {
      // console.log(`Download status for ${sessionId}: ${downloadStatus.completed}/${downloadStatus.total} completed`);
    // }
    
    // Strip sensitive auth data before sending to frontend
    const sanitizedSession = {
      ...session,
      auth: session.auth ? {
        cookieString: '✅',
        headers: '✅'
      } : undefined
    };
    
    // Return session.json with sensitive data stripped and articles added
    return NextResponse.json({
      ...sanitizedSession,
      articles: allArticles,
      downloadStatus,
      sessionSizeMB,
      paymentData
    });

  } catch (error) {
    console.error('Get status error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
