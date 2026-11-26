-- Add Stripe as a card-payment provider for Visa/Mastercard credit/debit cards.
ALTER TYPE "PaymentProvider" ADD VALUE 'STRIPE';
