# Ticketing app

Tiny plain-JavaScript Node.js >=22 app that runs on **Linux App Service**. It
serves one page, a health endpoint and a simulated checkout. There is no
database, Docker image, React build or real purchase.

## Start and validate

From this folder:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm start
```

The HTTP server binds to `0.0.0.0` on `PORT`, default `8080`. Do not commit
credentials or put them in browser code.

## Environment

| Variable | Meaning |
| --- | --- |
| `PORT` | HTTP listening port; default `8080` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Server-side SDK connection string; omit for local offline use |
| `APP_VERSION` | Version to report; default `dev` |
| `RELEASE_SHA` | Release (commit) to report; default `dev` |

## Release

The app reports the version and release (commit) it is running. `release.js`
resolves them from values baked in at bundling time (esbuild defines
`__APP_VERSION__` and `__RELEASE_SHA__`), then from `APP_VERSION` and
`RELEASE_SHA`, then falls back to `dev`. Every response, including 404 and 405,
carries `X-App-Version` and `X-Release-Sha` headers, and the page shows the
release next to the health status.

## Checkout

`POST /checkout` reserves tickets through `reserveTickets()`, which
`createHandler` accepts as an option so tests can replace it. The built-in
reservation is simulated and always succeeds; no purchase is made.

If the reservation throws, checkout answers `500` with a generic message and no
error details. The failure is tracked as an exception (message and stack) and as
a request with `resultCode` `500` and `outcome` `failed`, and the app writes one
`checkout-failed` JSON line to the console with the release and the error
message, never the stack. Health stays available.

## Routes and telemetry

| Method | Path | Result |
| --- | --- | --- |
| GET | `/` | Self-contained UI |
| GET | `/app.js`, `/styles.css` | Only explicitly allowlisted static assets |
| GET | `/healthz` | 200 JSON: `status`, `version` and `release` |
| POST | `/checkout` | 200 JSON for a simulated reservation, or 500 JSON if it fails |

Known paths with other methods return 405 with `Allow`; unknown paths return
404. Bodies are ignored.

SDK telemetry is manual-only, unsampled (`samplingPercentage: 100`): one request
named `POST /checkout` for each checkout, with its success, duration and HTTP
status, plus an exception for each failed checkout. Every request, exception and
event carries `releaseSha` and `appVersion` properties, and startup sends a
`ReleaseStarted` event when telemetry is configured. No request bodies, query
parameters, host headers or access tokens are recorded. Automatic dependency,
request, exception, console and live-metrics collection are disabled to prevent
duplicates and sensitive diagnostics. Missing telemetry config disables
telemetry without blocking the app. Unavailable telemetry never changes a
checkout response.

## Traffic

Manual checkout makes one request. The traffic loop waits for each request to
finish, then waits three seconds; it automatically stops at ten minutes. Stop
aborts the browser request and prevents subsequent attempts. No traffic starts on
load.
