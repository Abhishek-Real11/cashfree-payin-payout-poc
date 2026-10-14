# Mobile-team handoff: Cashfree UPI Intent

The web application already creates a Cashfree order, passes its
`payment_session_id` to Cashfree JS SDK v3, returns to the merchant URL, and
verifies the order with Cashfree from the server. Mobile browsers use a
full-page checkout; desktop browsers use a modal.

UPI Intent inside an application WebView requires native work. The WebView
must not try to load UPI URLs as web pages. It must intercept them, open the
matching installed UPI application, and cancel the WebView navigation.

Official guide:
https://www.cashfree.com/docs/payments/online/mobile/misc/upi_intent_support_js_sdk

## Mobile-team work

1. Confirm whether the container is Android, iOS, React Native, Flutter, or
   Cordova and identify the WebView that loads this web application.
2. Intercept Cashfree UPI navigation in that WebView. At minimum handle
   `upi://pay`, `intent://` on Android, `tez://`, `gpay://`, `phonepe://`,
   `paytmmp://`, `amazonpay://`, `credpay://`, and the additional schemes in
   Cashfree's current documentation.
3. Before launching a URL, check that an installed application can handle it.
   If none can, keep the customer in checkout and show a recoverable message.
4. Android 11+: add `<queries>` entries for the UPI schemes to
   `AndroidManifest.xml`; otherwise package discovery can return an empty list.
5. iOS: add every queried scheme to `LSApplicationQueriesSchemes` in
   `Info.plist`; otherwise `canOpenURL` returns `false`.
6. If using Cashfree's code-based solution, register the exact JavaScript
   bridge required by Cashfree: `Android` on Android or `nativeProcess` on iOS,
   and implement the methods from Cashfree's platform sample.
7. When control returns from a UPI app, restore/show the checkout verification
   UI. Do not treat the UPI app's result as proof of payment; let the web app
   verify the order with the server.

## Cashfree/account work

For the feature-flag solution, ask Cashfree Support to enable UPI Intent for
the merchant account only after the native URL handling above is ready.
Cashfree documents a 30–40 minute propagation time. The code-based bridge
solution does not require that feature flag.

## Environment needed for device testing

- A public HTTPS deployment of this application.
- `APP_BASE_URL` set to that public origin; `localhost` will point to the phone
  itself and will not work as the checkout return URL.
- Cashfree sandbox Payment Gateway credentials on the server.
- A physical device with a supported UPI app installed and SIM binding
  completed in that app.
- For WebView testing, a debug build containing the native URL interceptor.

## Acceptance checks

1. Create an order and open Cashfree Checkout from the app.
2. Select UPI and choose an installed app.
3. Confirm the native UPI app opens instead of a "Web Page not available"
   error.
4. Cancel once and confirm checkout remains recoverable.
5. Complete a sandbox test attempt and return to the merchant application.
6. Confirm the web application fetches the order status from the backend.
7. Repeat with no supported UPI app installed and confirm the fallback is
   understandable and does not leave a blank WebView.
