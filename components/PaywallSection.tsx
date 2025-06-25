"use client"

import { useCallback, useState } from "react";
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout
} from '@stripe/react-stripe-js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { stripePromise } from "@/lib/stripe-client";
import { AlertCircle, CheckCircle } from "lucide-react";

interface PaywallSectionProps {
  sessionId: string;
  articleCount: number;
}

export function PaywallSection({ sessionId, articleCount }: PaywallSectionProps) {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [alreadyPaid, setAlreadyPaid] = useState(false);
  
  const fetchClientSecret = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch("/api/payment/create-checkout-session", {
        method: "POST",
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sessionId })
      });
      
      const data = await response.json();
      
      if (data.alreadyPaid) {
        setAlreadyPaid(true);
        // Reload the page to refresh payment status
        setTimeout(() => {
          window.location.reload();
        }, 2000);
        return null;
      }
      
      if (!response.ok && !data.alreadyPaid) {
        throw new Error(data.error || 'Failed to create checkout session');
      }
      
      setIsLoading(false);
      return data.clientSecret;
    } catch (err: any) {
      setIsLoading(false);
      setError(err.message || 'Failed to initialize payment. Please try again.');
      throw err;
    }
  }, [sessionId]);

  const options = { fetchClientSecret };

  return (
    <Card className="mb-8 border-orange-200 bg-orange-50">
      <CardHeader>
        <CardTitle className="text-2xl font-bold flex items-center gap-2">
          <AlertCircle className="w-6 h-6 text-orange-600" />
          Unlock Unlimited Article Export
        </CardTitle>
        <CardDescription className="text-lg">
          <p className="text-orange-700 font-medium mb-2">
            You've reached the free limit of 100 articles
          </p>
          <p className="text-gray-700">
            You've exported {articleCount} articles so far. To continue exporting all your Pocket articles, 
            please complete a one-time payment of $8.00 to support the service.
          </p>
        </CardDescription>
      </CardHeader>
      
      <CardContent>
        {alreadyPaid ? (
          <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-green-700">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-5 h-5" />
              <span>Payment already completed! Refreshing page...</span>
            </div>
          </div>
        ) : error ? (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
            {error}
          </div>
        ) : (
          <div className="bg-white rounded-lg p-6 border border-orange-200">
            <EmbeddedCheckoutProvider
              stripe={stripePromise}
              options={options}
            >
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          </div>
        )}
      </CardContent>
    </Card>
  );
}