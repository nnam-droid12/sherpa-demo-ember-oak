# Ember & Oak

A fictional outdoor-gear store used as a demo target for Sherpa. Plain HTML, CSS and JavaScript on the front end, Express on the back end, PayPal Orders v2 in the sandbox.

This baseline is intentionally flawed so Sherpa has something to audit and fix. The list of planted issues lives in the Sherpa repo under `docs/SCORECARD.md`.

## Run locally

```bash
npm install
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm start
```

Sandbox only. Never use live PayPal credentials with this store.
