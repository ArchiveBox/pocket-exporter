"use client"

import { useCallback, useState } from "react";
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout
} from '@stripe/react-stripe-js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { stripePromise } from "@/lib/stripe-client";
import { AlertCircle } from "lucide-react";

interface PaywallModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  articleCount: number;
}

export function PaywallModal({ isOpen, onClose, sessionId, articleCount }: PaywallModalProps) {
  const [error, setError] = useState<string | null>(null);
  
  const fetchClientSecret = useCallback(async () => {
    try {
      const response = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sessionId })
      });
      
      if (!response.ok) {
        throw new Error('Failed to create checkout session');
      }
      
      const data = await response.json();
      return data.clientSecret;
    } catch (err) {
      setError('Failed to initialize payment. Please try again.');
      throw err;
    }
  }, [sessionId]);

  const options = { fetchClientSecret };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold">Unlock Unlimited Article Export</DialogTitle>
          <DialogDescription className="text-lg mt-2">
            <div className="flex items-center gap-2 text-orange-600 mb-4">
              <AlertCircle className="w-5 h-5" />
              <span>You've reached the free limit of 100 articles</span>
            </div>
            <p className="text-gray-600">
              You've exported {articleCount} articles so far. To continue exporting all your Pocket articles, 
              please complete a one-time payment of $10.00 to support the service
            </p>
          </DialogDescription>
        </DialogHeader>
        
        <div className="mt-6">
          {error ? (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
              {error}
            </div>
          ) : (
            <EmbeddedCheckoutProvider
              stripe={stripePromise}
              options={options}
            >
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
