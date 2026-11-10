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

## Checkout

`POST /checkout` reserves tickets through `reserveTickets()`, which
`createHandler` accepts as an option so tests can replace it. The built-in
reservation is simulated and always succeeds; no purchase is made.

## Routes and telemetry

| Method | Path | Result |
| --- | --- | --- |
| GET | `/` | Self-contained UI |
| GET | `/app.js`, `/styles.css` | Only explicitly allowlisted static assets |
| GET | `/healthz` | 200 JSON |
| POST | `/checkout` | 200 JSON for a simulated reservation |

Known paths with other methods return 405 with `Allow`; unknown paths return
404. Bodies are ignored.

SDK telemetry is manual-only, unsampled (`samplingPercentage: 100`): one request
named `POST /checkout` for each checkout, with its success, duration and HTTP
status. No request bodies, query parameters, host headers or access tokens are
recorded. Automatic dependency, request, exception, console and live-metrics
collection are disabled to prevent duplicates and sensitive diagnostics. Missing
telemetry config disables telemetry without blocking the app. Unavailable
telemetry never fails checkout.

## Traffic

Manual checkout makes one request. The traffic loop waits for each request to
finish, then waits three seconds; it automatically stops at ten minutes. Stop
aborts the browser request and prevents subsequent attempts. No traffic starts on
load.
