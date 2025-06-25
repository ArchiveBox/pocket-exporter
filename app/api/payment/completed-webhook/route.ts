import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { updatePaymentData, readPaymentData } from '@/lib/session-utils';
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
        let chargeData = {};
        
        // Retrieve charge information if payment intent exists
        if (checkoutSession.payment_intent) {
          try {
            const paymentIntent = await stripe.paymentIntents.retrieve(checkoutSession.payment_intent as string);
            if (paymentIntent.latest_charge) {
              const charge = await stripe.charges.retrieve(paymentIntent.latest_charge as string);
              chargeData = {
                stripeChargeId: charge.id,
                receiptUrl: charge.receipt_url,
                receiptEmail: charge.receipt_email,
                customerId: charge.customer as string,
                currency: charge.currency,
                amount: charge.amount
              };
              console.log(`Retrieved charge ${charge.id} for payment intent ${paymentIntent.id}`);
            }
          } catch (chargeError) {
            console.error('Error retrieving charge:', chargeError);
          }
        }
        
        const existingData = updatePaymentData(appSessionId, {
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
            ...chargeData
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
        
        let chargeData = {};
        // Retrieve charge information
        if (paymentIntent.latest_charge) {
          try {
            const charge = await stripe.charges.retrieve(paymentIntent.latest_charge as string);
            chargeData = {
              stripeChargeId: charge.id,
              receiptUrl: charge.receipt_url,
              receiptEmail: charge.receipt_email,
              customerId: charge.customer as string,
              currency: charge.currency,
              amount: charge.amount
            };
            console.log(`Retrieved charge ${charge.id} for payment intent ${paymentIntent.id}`);
          } catch (chargeError) {
            console.error('Error retrieving charge:', chargeError);
          }
        }
        
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
            ...chargeData
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