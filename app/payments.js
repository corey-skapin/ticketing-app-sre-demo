'use strict';

async function authorizePayment({ env, orderId, amountCents, fetchImpl = fetch }) {
  const gatewayUrl = env.PAYMENT_GATEWAY_URL;
  if (!gatewayUrl) {
    throw new Error('PAYMENT_GATEWAY_URL is not configured');
  }
  const response = await fetchImpl(new URL('/v1/authorize', gatewayUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, amountCents }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    throw new Error(`Payment gateway returned ${response.status}`);
  }
  return response.json();
}

module.exports = { authorizePayment };
