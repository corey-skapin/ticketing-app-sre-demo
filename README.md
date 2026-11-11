# Ticketing app

A small Node.js site for reserving tickets to a fictional concert. It serves one
page, a health endpoint and a simulated `POST /checkout`; no purchase is ever
made. This repository is the sample app for an Azure SRE Agent demo.

This repository holds the application only. The infrastructure that hosts it
lives elsewhere.

## Run it locally

You need Node.js 22 or later.

```sh
cd app
npm ci --ignore-scripts
npm start
```

Open <http://localhost:8080>. `GET /healthz` reports the version and release the
app is running, and every response carries them in the `X-App-Version` and
`X-Release-Sha` headers.

## Test it

```sh
cd app
npm test
npm run check
```

The tests run offline.

## Package it

```sh
cd app
npm ci --ignore-scripts
npm run package
```

This writes `app/dist/ticketing-app-v<version>.zip`. The zip holds the whole app
bundled into a single `server.js`, with its source map, a minimal `package.json`
and the `public` folder. It needs no `npm install` and runs from a read-only
folder.

## Configuration

You configure the app with environment variables.

| Variable | Meaning |
| --- | --- |
| `PORT` | Port to listen on. Defaults to `8080`. |
| `PAYMENT_GATEWAY_URL` | Base URL of the payment gateway; required for checkout. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Optional. Sends telemetry to Application Insights when set. |
| `APP_VERSION` | Optional. The version the app reports when you run it from source. Defaults to `dev`. A packaged build reports its own. |
| `RELEASE_SHA` | Optional. The release (commit) the app reports when you run it from source. Defaults to `dev`. A packaged build reports its own. |

## Releases and rollback

Pushes to `main` and pull requests run the tests and build the package. Every tag
that starts with `v` publishes a release: the release workflow checks that the tag
equals `v` plus the version in `app/package.json`, runs the tests, builds the
package and attaches `ticketing-app-<tag>.zip` to a GitHub release. You can
download it from:

```text
https://github.com/<owner>/<repo>/releases/download/<tag>/ticketing-app-<tag>.zip
```

The zip root holds the single-file bundle (`server.js` and `server.js.map`), a
minimal `package.json` and the `public` folder. The app runs from that package:
set the App Service setting `PAYMENT_GATEWAY_URL` to the environment's payment
gateway base URL before deploying, then set `WEBSITE_RUN_FROM_PACKAGE` to the
asset URL and restart the app. Without `PAYMENT_GATEWAY_URL`, checkout returns a
503 with a `configuration_missing` telemetry outcome. To roll back, point
`WEBSITE_RUN_FROM_PACKAGE` at an earlier tag's asset.

`GET /healthz` reports the `version` and `release` the app is running, so you can
confirm which package is live.
