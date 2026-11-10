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

Open <http://localhost:8080>.

## Test it

```sh
cd app
npm test
npm run check
```

The tests run offline.

## Configuration

You configure the app with environment variables.

| Variable | Meaning |
| --- | --- |
| `PORT` | Port to listen on. Defaults to `8080`. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Optional. Sends telemetry to Application Insights when set. |
