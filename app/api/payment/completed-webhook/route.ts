import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { updatePaymentData, readPaymentData, fetchCompletePaymentDetails } from '@/lib/session-utils';
import { headers } from 'next/headers';

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = headers().get('stripe-signature') as string;

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET || ''
    );
  } catch (err: any) {
    console.log(`Webhook signature verification failed.`, err.message);
    return NextResponse.json(
      { error: `Webhook Error: ${err.message}` },
      { status: 400 }
    );
  }

  console.log(`Webhook received: ${event.type}`);
  
  if (event.type === 'checkout.session.completed') {
    const checkoutSession = event.data.object;
    const appSessionId = checkoutSession.metadata?.appSessionId;

    console.log(`Checkout session completed: ${checkoutSession.id}, app session: ${appSessionId}`);

    if (appSessionId) {
      try {
        // Fetch complete payment details including charge and receipt
        const completeDetails = await fetchCompletePaymentDetails(
          checkoutSession.id,
          checkoutSession.payment_intent as string
        );
        
        const existingData = await updatePaymentData(appSessionId, {
          hasUnlimitedAccess: true,
          payment: {
            status: 'completed',
            stripeSessionId: checkoutSession.id,
            stripePaymentIntentId: checkoutSession.payment_intent as string,
            amount: checkoutSession.amount_total || 0,
            currency: checkoutSession.currency || 'usd',
            createdAt: new Date(checkoutSession.created * 1000).toISOString(),
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...completeDetails
          }
        });
        
        console.log(`Payment successful for session ${appSessionId}, updated data:`, existingData);
      } catch (error) {
        console.error('Error updating payment status:', error);
      }
    } else {
      console.error('No appSessionId found in checkout session metadata');
    }
  } else if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    const appSessionId = paymentIntent.metadata?.appSessionId;

    console.log(`Payment intent succeeded: ${paymentIntent.id}, app session: ${appSessionId}`);

    if (appSessionId) {
      try {
        // Check if we already have a payment record
        const existingPayment = readPaymentData(appSessionId);
        
        // Fetch complete payment details including charge and receipt
        const completeDetails = await fetchCompletePaymentDetails(
          existingPayment?.payment?.stripeSessionId,
          paymentIntent.id
        );
        
        const updatedData = updatePaymentData(appSessionId, {
          hasUnlimitedAccess: true,
          payment: {
            status: 'completed',
            stripeSessionId: existingPayment?.payment?.stripeSessionId || 'payment_intent_direct',
            stripePaymentIntentId: paymentIntent.id,
            amount: paymentIntent.amount || 0,
            currency: paymentIntent.currency || 'usd',
            createdAt: existingPayment?.payment?.createdAt || new Date().toISOString(),
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...completeDetails
          }
        });
        
        console.log(`Payment intent successful for session ${appSessionId}, updated data:`, updatedData);
      } catch (error) {
        console.error('Error updating payment status from payment intent:', error);
      }
    }
  }

  return NextResponse.json({ received: true });
}