const $ = (selector) => document.querySelector(selector);
const isLoopbackPreview = ['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '5052';
const apiBase = isLoopbackPreview ? 'http://localhost:5052' : '';
let beneficiaryId = null;
let currentOrderId = null;
let currentTransferId = null;
let cashfree;

const mobileUserAgent = navigator.userAgentData?.mobile === true
  || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// A full-page checkout is more reliable on mobile browsers and when this page is
// hosted inside an app WebView. The native app must still intercept UPI schemes.
const checkoutRedirectTarget = mobileUserAgent ? '_self' : '_modal';

async function api(url, options = {}) {
  const response = await fetch(`${apiBase}${url}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) {
    const detail = data.details?.message || data.details?.code;
    throw new Error([data.error || data.message || `Request failed (HTTP ${response.status})`, detail].filter(Boolean).join(' — '));
  }
  return data;
}
function show(target, value) { $(target).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function setBusy(button, busy, label) { button.disabled = busy; if (busy) { button.dataset.oldLabel = button.textContent; button.textContent = label; } else { button.textContent = button.dataset.oldLabel || button.textContent; } }

api('/api/config').then(config => {
  const badge = $('#envBadge');
  const allReady = config.payinConfigured && config.payoutsEnabled;
  const readiness = allReady ? 'Pay-in & payout ready' : config.payinConfigured ? 'Pay-in ready · payout locked' : 'credentials needed';
  badge.textContent = `Environment: ${config.environment} · ${readiness}`;
  badge.classList.toggle('ready', allReady || config.payinConfigured);
  try {
    cashfree = Cashfree({ mode: config.cashfreeMode });
  } catch (error) { console.error('Cashfree checkout SDK could not be initialized:', error); }
  const intentReadiness = $('#upiIntentReadiness');
  if (mobileUserAgent) {
    intentReadiness.textContent = 'Mobile checkout mode: Cashfree will open full-page. In an app WebView, the mobile app must intercept UPI deep links and launch the selected UPI app.';
  } else {
    intentReadiness.textContent = 'Desktop checkout mode: Cashfree opens in a modal. Test the actual UPI Intent launch on a physical mobile device with a SIM-bound UPI app.';
  }
  if (!config.payinConfigured) document.querySelectorAll('#payinForm button, #orderLookupForm button').forEach(button => { button.disabled = true; });
  const payoutLock = $('#payoutLock');
  if (config.environment !== 'sandbox') payoutLock.textContent = 'Payout calls are blocked because this POC permits them only in sandbox.';
  else if (!config.payoutConfigured) payoutLock.textContent = 'Add your Cashfree Payout sandbox credentials to .env to enable payout calls.';
  else payoutLock.textContent = 'Set ENABLE_SANDBOX_PAYOUTS=true in .env and restart the server to enable payout calls.';
  payoutLock.hidden = config.payoutsEnabled;
  if (!config.payoutsEnabled) document.querySelectorAll('.payout-button').forEach(button => { button.disabled = true; });
}).catch(error => show('#envBadge', error.message));

$('#payinForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  setBusy(button, true, 'Creating order…');
  try {
    const form = new FormData(event.currentTarget);
    const created = await api('/api/payin/orders', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
    currentOrderId = created.orderId;
    const checkoutMode = checkoutRedirectTarget === '_self' ? 'mobile full-page' : 'desktop modal';
    show('#payinResult', `Order created: ${created.orderId}\nOpening Cashfree Checkout (${checkoutMode})…`);
    $('#verifyPayin').hidden = false;
    if (!cashfree) throw new Error('Cashfree Checkout SDK did not load. Check your internet connection and reload.');
    const checkoutResult = await cashfree.checkout({
      paymentSessionId: created.paymentSessionId,
      redirectTarget: checkoutRedirectTarget
    });
    if (checkoutResult?.error) throw new Error(checkoutResult.error.message || 'Cashfree Checkout could not complete.');
    if (checkoutResult?.redirect) {
      show('#payinResult', `Cashfree is redirecting the payment flow.\nOrder ID: ${currentOrderId}`);
      return;
    }
    const message = checkoutResult?.paymentDetails?.paymentMessage || 'Checkout closed.';
    show('#payinResult', `${message}\nVerify the order status below.\nOrder ID: ${currentOrderId}`);
  } catch (error) { show('#payinResult', `Error: ${error.message}`); }
  finally { setBusy(button, false); }
});

$('#verifyPayinBtn').addEventListener('click', async () => {
  if (!currentOrderId) return;
  try { show('#payinResult', await api(`/api/payin/orders/${encodeURIComponent(currentOrderId)}`)); }
  catch (error) { show('#payinResult', `Error: ${error.message}`); }
});

$('#orderLookupForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  const orderId = String(new FormData(event.currentTarget).get('orderId') || '').trim();
  if (!orderId) return;
  setBusy(button, true, 'Checking…');
  try {
    currentOrderId = orderId;
    $('#verifyPayin').hidden = false;
    show('#payinResult', await api(`/api/payin/orders/${encodeURIComponent(orderId)}`));
  } catch (error) { show('#payinResult', `Error: ${error.message}`); }
  finally { setBusy(button, false); }
});

$('#beneficiaryForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  setBusy(button, true, 'Adding beneficiary…');
  try {
    const created = await api('/api/payouts/beneficiaries', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    beneficiaryId = created.beneficiaryId;
    $('#beneficiaryId').value = beneficiaryId;
    show('#beneficiaryResult', `Beneficiary created and accepted by Cashfree.\nID: ${beneficiaryId}`);
    show('#transferResult', 'Ready to create a sandbox transfer.');
  } catch (error) { show('#beneficiaryResult', `Error: ${error.message}`); }
  finally { setBusy(button, false); }
});

$('#transferForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  setBusy(button, true, 'Submitting transfer…');
  try {
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    beneficiaryId = String(payload.beneficiaryId || '').trim();
    if (!beneficiaryId) throw new Error('Create a beneficiary or enter an existing beneficiary ID first.');
    const result = await api('/api/payouts/transfers', { method: 'POST', body: JSON.stringify(payload) });
    currentTransferId = result.transferId;
    show('#transferResult', result);
    $('#verifyTransfer').hidden = false;
  } catch (error) { show('#transferResult', `Error: ${error.message}`); }
  finally { setBusy(button, false); }
});

$('#upiTransferForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  setBusy(button, true, 'Paying UPI ID…');
  try {
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api('/api/payouts/upi-transfers', { method: 'POST', body: JSON.stringify(payload) });
    currentTransferId = result.transferId;
    show('#transferResult', result);
    $('#verifyTransfer').hidden = false;
  } catch (error) { show('#transferResult', `Error: ${error.message}`); }
  finally { setBusy(button, false); }
});

$('#verifyTransferBtn').addEventListener('click', async () => {
  if (!currentTransferId) return;
  try { show('#transferResult', await api(`/api/payouts/transfers/${encodeURIComponent(currentTransferId)}`)); }
  catch (error) { show('#transferResult', `Error: ${error.message}`); }
});

$('#transferLookupForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  const transferId = String(new FormData(event.currentTarget).get('transferId') || '').trim();
  if (!transferId) return;
  setBusy(button, true, 'Checking…');
  try {
    currentTransferId = transferId;
    $('#verifyTransfer').hidden = false;
    show('#transferResult', await api(`/api/payouts/transfers/${encodeURIComponent(transferId)}`));
  } catch (error) { show('#transferResult', `Error: ${error.message}`); }
  finally { setBusy(button, false); }
});

const params = new URLSearchParams(location.search);
const returnedOrderId = params.get('order_id');
if (returnedOrderId) {
  currentOrderId = returnedOrderId;
  $('#verifyPayin').hidden = false;
  show('#payinResult', `Returned from checkout. Checking order ${returnedOrderId}…`);
  api(`/api/payin/orders/${encodeURIComponent(returnedOrderId)}`)
    .then(data => show('#payinResult', data))
    .catch(error => show('#payinResult', `Could not verify order: ${error.message}`));
}
