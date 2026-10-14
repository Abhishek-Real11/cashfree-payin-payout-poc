# Cashfree Pay-in & Payout POC

A small Node.js/Express sandbox demo. It includes Cashfree hosted checkout for pay-ins, server-side order verification, bank-beneficiary transfers, direct UPI-ID payouts, and transfer status lookup.

## Requirements

- Node.js 20 or newer
- Cashfree sandbox Payment Gateway and Payout credentials
- Sandbox payout access enabled on the Cashfree account

## Run it

```bash
cp .env.example .env
# Add your Payment Gateway test App ID and Secret Key to .env.
# To test Payouts, separately add CASHFREE_PAYOUT_CLIENT_ID and
# CASHFREE_PAYOUT_CLIENT_SECRET from the Payouts dashboard.
nvm use
npm install
npm start
```

Open http://localhost:5052. Pay-in checkout runs in sandbox. For payout testing, set `ENABLE_SANDBOX_PAYOUTS=true` in `.env` and restart the server. The server rejects payout requests unless `CASHFREE_ENV=sandbox`. The page can also look up an existing order ID or transfer ID.

The checkout opens in a modal on desktop and uses a full-page redirect on
mobile. A normal mobile browser can hand Cashfree's UPI Intent URL to an
installed UPI app. When this website is embedded in an application WebView,
the mobile app must additionally intercept Cashfree's UPI deep links. See
[MOBILE_UPI_HANDOFF.md](./MOBILE_UPI_HANDOFF.md) for the native-team contract
and device acceptance checks.

The page also supports VS Code **Go Live** on a loopback address such as `http://127.0.0.1:5500/public/index.html`, provided the Node server is running on port `5052` in another terminal.

## Demo flow

1. Enter the sandbox customer amount and phone, create an order, and complete Cashfree Checkout with Cashfree's sandbox test payment details.
2. Confirm status via the server-side Cashfree order API. The return URL is only a navigation aid; the app checks order status with Cashfree.
3. Enable sandbox payouts, then either add a bank beneficiary and transfer to it or make a direct UPI-ID payout.
4. Use the returned transfer ID to fetch the transfer status.

The payout forms are prefilled with Cashfree's documented sandbox-success bank account (`00011020001772`, `HDFC0000001`) and VPA (`success@upi`). Test-mode payouts are simulated and do not move real money.

The app does not save customer or bank details. It uses generated IDs and keeps no transaction database, so it is for a local proof of concept only.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/payin/orders` | Create Payment Gateway order and return payment session ID |
| GET | `/api/payin/orders/:orderId` | Fetch order status from Cashfree |
| POST | `/api/payouts/beneficiaries` | Create a payout beneficiary (sandbox only) |
| POST | `/api/payouts/transfers` | Initiate a transfer to an existing beneficiary (sandbox only) |
| POST | `/api/payouts/upi-transfers` | Initiate a direct transfer to a UPI ID/VPA (sandbox only) |
| GET | `/api/payouts/transfers/:transferId` | Fetch transfer status |
| POST | `/api/webhooks/payment` | Verify payment webhook signature using the raw request body |

## API versions and references

- Payment Gateway Orders use API version `2026-01-01`: [Cashfree PG API reference](https://www.cashfree.com/docs/api-reference/payments/latest/overview)
- Payout v2 Beneficiary and Transfer APIs use API version `2024-01-01`: [Beneficiary API](https://www.cashfree.com/docs/api-reference/overview), [Payout Transfers API](https://docs.cashfree.com/reference/payouts-version2-apis)
- Webhook signature verification uses the timestamp plus the exact raw request body, HMAC-SHA256, Base64: [Cashfree webhook verification example](https://www.cashfree.com/devstudio/preview/pg/tools/webhookVerification)

## Before production

This POC is sandbox-first. Before production, add durable order/transfer records, idempotency and webhook event storage, authentication/authorization and CSRF protections, request validation/rate limits, audit logging, payout approval controls, reconciliation, alerting, and secrets management. Test Cashfree's supported sandbox cases and confirm account-level payout setup with Cashfree. Never expose API secrets in browser code or treat the checkout redirect as payment confirmation.
