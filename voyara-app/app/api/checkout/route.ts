import { NextResponse } from 'next/server';
import { env, modes } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Membership checkout. The subscription is the business model, so this is
 * the single most important money route in the app.
 *
 * Uses Stripe's REST API directly rather than the SDK to keep the
 * dependency surface small. Swap for the SDK when webhooks land.
 */
export async function POST() {
  if (modes.payments() === 'mock') {
    return NextResponse.json({
      mode: 'mock',
      message: 'Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID to take a real payment.',
      url: null
    });
  }

  const body = new URLSearchParams();
  body.set('mode', 'subscription');
  body.set('line_items[0][price]', env.stripePrice);
  body.set('line_items[0][quantity]', '1');
  body.set('success_url', `${env.siteUrl}/?membership=active`);
  body.set('cancel_url', `${env.siteUrl}/?membership=cancelled`);

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.stripeSecret}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      cache: 'no-store'
    });
    const json: any = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        { error: 'stripe_error', detail: json?.error?.message ?? 'unknown' },
        { status: 502 }
      );
    }
    return NextResponse.json({ mode: 'live', url: json.url, id: json.id });
  } catch (e: any) {
    return NextResponse.json({ error: 'stripe_unreachable', detail: String(e?.message || e) }, { status: 502 });
  }
}
