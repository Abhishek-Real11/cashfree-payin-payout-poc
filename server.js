import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nodeMajorVersion = Number(process.versions.node.split('.')[0]);
if (nodeMajorVersion < 20) {
  console.error(`Node.js 20 or newer is required (current: ${process.version}). Run \"nvm use\" before \"npm start\".`);
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT || 5052);
const baseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
const env = process.env.CASHFREE_ENV || 'sandbox';
const isSandbox = env === 'sandbox';
const pgBase = isSandbox ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
const payoutBase = isSandbox ? 'https://sandbox.cashfree.com/payout' : 'https://api.cashfree.com/payout';
const pgVersion = '2026-01-01';
const payoutVersion = '2024-01-01';
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

function validCredentialPair(clientId, clientSecret) {
  return Boolean(clientId && clientSecret && !clientId.includes('your_') && !clientSecret.includes('your_'));
}

function paymentCredentials() {
  return {
    clientId: process.env.CASHFREE_CLIENT_ID,
    clientSecret: process.env.CASHFREE_CLIENT_SECRET
  };
}

function payoutCredentials() {
  return {
    clientId: process.env.CASHFREE_PAYOUT_CLIENT_ID,
    clientSecret: process.env.CASHFREE_PAYOUT_CLIENT_SECRET
  };
}

function requirePaymentConfig(req, res, next) {
  const { clientId, clientSecret } = paymentCredentials();
  if (!validCredentialPair(clientId, clientSecret)) return res.status(503).json({ error: 'Add Cashfree Payment Gateway sandbox credentials to .env first.' });
  next();
}

function requirePayoutConfig(req, res, next) {
  const { clientId, clientSecret } = payoutCredentials();
  if (!validCredentialPair(clientId, clientSecret)) return res.status(503).json({ error: 'Add Cashfree Payout sandbox credentials to .env first.' });
  next();
}

function requireSandboxPayouts(req, res, next) {
  if (!isSandbox) return res.status(403).json({ error: 'This POC only allows payouts in sandbox. Set CASHFREE_ENV=sandbox.' });
  if (process.env.ENABLE_SANDBOX_PAYOUTS !== 'true') return res.status(403).json({ error: 'Payouts are disabled. Set ENABLE_SANDBOX_PAYOUTS=true after configuring sandbox credentials.' });
  next();
}

async function cashfreeRequest(url, options = {}, apiVersion = pgVersion, credentials = paymentCredentials()) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'x-client-id': credentials.clientId,
      'x-client-secret': credentials.clientSecret,
      'x-api-version': apiVersion,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const err = new Error(data.message || data.error || `Cashfree returned HTTP ${response.status}`);
    err.status = response.status;
    err.details = data;
    throw err;
  }
  return data;
}

function handleApiError(res, error) {
  console.error('Cashfree API error:', error.details || error.message);
  return res.status(error.status || 500).json({ error: error.message, details: error.details });
}

// Allow local static preview tools such as VS Code Live Server to call this
// sandbox backend. Non-loopback origins and production remain disallowed.
app.use((req, res, next) => {
  const origin = req.header('origin');
  const localPreview = isSandbox && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || '');
  if (localPreview) {
    res.set({
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

// Raw body is required to verify Cashfree payment webhook signatures.
app.post('/api/webhooks/payment', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.header('x-webhook-signature');
  const timestamp = req.header('x-webhook-timestamp');
  const secret = process.env.CASHFREE_CLIENT_SECRET;
  if (!signature || !timestamp || !secret || !Buffer.isBuffer(req.body)) {
    return res.status(400).json({ error: 'Missing webhook headers or raw request body.' });
  }
  const expected = crypto.createHmac('sha256', secret)
    .update(timestamp + req.body.toString('utf8'))
    .digest('base64');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return res.status(401).json({ error: 'Invalid webhook signature.' });
  }
  const event = JSON.parse(req.body.toString('utf8'));
  console.log('Verified Cashfree payment webhook:', event.type || 'unknown event');
  // In production, persist/update order status idempotently before returning 200.
  return res.status(200).json({ received: true });
});

app.use(express.json());
app.use(express.static(publicDirectory));

app.get('/api/config', (_req, res) => {
  const payin = paymentCredentials();
  const payout = payoutCredentials();
  const payinConfigured = validCredentialPair(payin.clientId, payin.clientSecret);
  const payoutConfigured = validCredentialPair(payout.clientId, payout.clientSecret);
  res.json({
    environment: env,
    payinConfigured,
    payoutConfigured,
    payoutsEnabled: isSandbox && payoutConfigured && process.env.ENABLE_SANDBOX_PAYOUTS === 'true',
    cashfreeMode: isSandbox ? 'sandbox' : 'production'
  });
});

app.post('/api/payin/orders', requirePaymentConfig, async (req, res) => {
  const amount = Number(req.body.amount);
  const phone = String(req.body.phone || '').trim();
  const email = String(req.body.email || '').trim();
  if (!Number.isFinite(amount) || amount < 1 || amount > 100000) return res.status(400).json({ error: 'Amount must be between ₹1 and ₹1,00,000 for this POC.' });
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a 10-digit customer phone number.' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid customer email address.' });
  const orderId = `poc_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  try {
    const data = await cashfreeRequest(`${pgBase}/orders`, {
      method: 'POST',
      headers: {
        'x-request-id': crypto.randomUUID(),
        'x-idempotency-key': crypto.randomUUID()
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: Number(amount.toFixed(2)),
        order_currency: 'INR',
        customer_details: {
          customer_id: `poc_${phone}`,
          customer_phone: phone,
          ...(email ? { customer_email: email } : {})
        },
        order_meta: { return_url: `${baseUrl}/?order_id={order_id}` }
      })
    });
    res.json({ orderId, paymentSessionId: data.payment_session_id, orderStatus: data.order_status });
  } catch (error) { handleApiError(res, error); }
});

app.get('/api/payin/orders/:orderId', requirePaymentConfig, async (req, res) => {
  try {
    const data = await cashfreeRequest(`${pgBase}/orders/${encodeURIComponent(req.params.orderId)}`);
    res.json(data);
  } catch (error) { handleApiError(res, error); }
});

app.post('/api/payouts/beneficiaries', requirePayoutConfig, requireSandboxPayouts, async (req, res) => {
  const { name, accountNumber, ifsc, phone } = req.body;
  const cleanName = String(name || '').trim();
  const cleanAccountNumber = String(accountNumber || '').trim();
  const cleanIfsc = String(ifsc || '').trim().toUpperCase();
  const cleanPhone = String(phone || '').trim();
  if (!/^[A-Za-z ]{1,100}$/.test(cleanName)) return res.status(400).json({ error: 'Beneficiary name may contain only letters and spaces.' });
  if (!/^[A-Za-z0-9]{4,25}$/.test(cleanAccountNumber)) return res.status(400).json({ error: 'Bank account number must be 4–25 letters or digits.' });
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleanIfsc)) return res.status(400).json({ error: 'Enter a valid 11-character IFSC.' });
  if (!/^\d{10}$/.test(cleanPhone)) return res.status(400).json({ error: 'Enter a 10-digit beneficiary phone number.' });
  const beneficiaryId = `poc_bene_${Date.now()}`;
  const body = {
    beneficiary_id: beneficiaryId,
    beneficiary_name: cleanName,
    beneficiary_instrument_details: {
      bank_account_number: cleanAccountNumber,
      bank_ifsc: cleanIfsc
    },
    beneficiary_contact_details: { beneficiary_phone: cleanPhone }
  };
  try {
    const data = await cashfreeRequest(`${payoutBase}/beneficiary`, {
      method: 'POST',
      headers: { 'x-request-id': crypto.randomUUID() },
      body: JSON.stringify(body)
    }, payoutVersion, payoutCredentials());
    res.status(201).json({ beneficiaryId, ...data });
  } catch (error) { handleApiError(res, error); }
});

app.post('/api/payouts/transfers', requirePayoutConfig, requireSandboxPayouts, async (req, res) => {
  const amount = Number(req.body.amount);
  const beneficiaryId = String(req.body.beneficiaryId || '').trim();
  if (!beneficiaryId) return res.status(400).json({ error: 'Create a beneficiary first and provide its beneficiary ID.' });
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) return res.status(400).json({ error: 'Sandbox transfer amount must be between ₹1 and ₹10,000.' });
  const transferId = `poc_txn_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  try {
    const data = await cashfreeRequest(`${payoutBase}/transfers`, {
      method: 'POST',
      headers: { 'x-request-id': crypto.randomUUID() },
      body: JSON.stringify({
        transfer_id: transferId,
        transfer_amount: Number(amount.toFixed(2)),
        transfer_currency: 'INR',
        transfer_mode: 'banktransfer',
        transfer_remarks: 'Cashfree sandbox POC',
        beneficiary_details: { beneficiary_id: beneficiaryId }
      })
    }, payoutVersion, payoutCredentials());
    res.json({ transferId, ...data });
  } catch (error) { handleApiError(res, error); }
});

app.post('/api/payouts/upi-transfers', requirePayoutConfig, requireSandboxPayouts, async (req, res) => {
  const amount = Number(req.body.amount);
  const name = String(req.body.name || '').trim();
  const vpa = String(req.body.vpa || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  if (!/^[A-Za-z ]{1,100}$/.test(name)) return res.status(400).json({ error: 'Beneficiary name may contain only letters and spaces.' });
  if (!/^[a-z0-9._-]{2,256}@[a-z0-9._]{2,64}$/.test(vpa)) return res.status(400).json({ error: 'Enter a valid UPI ID, for example success@upi.' });
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a 10-digit beneficiary phone number.' });
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) return res.status(400).json({ error: 'Sandbox transfer amount must be between ₹1 and ₹10,000.' });
  const transferId = `poc_upi_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  try {
    const data = await cashfreeRequest(`${payoutBase}/transfers`, {
      method: 'POST',
      headers: { 'x-request-id': crypto.randomUUID() },
      body: JSON.stringify({
        transfer_id: transferId,
        transfer_amount: Number(amount.toFixed(2)),
        transfer_currency: 'INR',
        transfer_mode: 'upi',
        transfer_remarks: 'Cashfree sandbox UPI POC',
        beneficiary_details: {
          beneficiary_name: name,
          beneficiary_instrument_details: { vpa },
          beneficiary_contact_details: { beneficiary_phone: phone }
        }
      })
    }, payoutVersion, payoutCredentials());
    res.json({ transferId, ...data });
  } catch (error) { handleApiError(res, error); }
});

app.get('/api/payouts/transfers/:transferId', requirePayoutConfig, requireSandboxPayouts, async (req, res) => {
  try {
    const url = new URL(`${payoutBase}/transfers`);
    url.searchParams.set('transfer_id', req.params.transferId);
    const data = await cashfreeRequest(url.toString(), {
      headers: { 'x-request-id': crypto.randomUUID() }
    }, payoutVersion, payoutCredentials());
    res.json(data);
  } catch (error) { handleApiError(res, error); }
});

app.listen(port, () => {
  console.log(`Cashfree POC listening at http://localhost:${port} (${env})`);
  if (baseUrl !== `http://localhost:${port}`) console.log(`Cashfree return URL base: ${baseUrl}`);
});
