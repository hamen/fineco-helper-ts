# fineco-helper

A small local helper for exporting your Fineco portfolio positions as JSON, CSV, and a clean HTML report.

![Example report using fake demo data](docs/example-report.svg)

## Privacy First

`fineco-helper` is intentionally boring about data:

- It runs locally on your machine.
- It does not store your Fineco username or password.
- It does not send your portfolio data to any third-party service.
- It only talks to Fineco endpoints needed to log in, fetch positions, and log out.
- Generated reports are written only to your local filesystem.

Credentials are read from command-line arguments, environment variables, or the 1Password CLI. They are used for the login request and are not printed.

## What It Does

1. Creates the same public-session cookies Fineco expects from the web app.
2. Logs in to Fineco.
3. Calls Fineco's private positions summary endpoint.
4. Writes `portfolio-report.html`.
5. Prints JSON, CSV, or raw API JSON to stdout.
6. Calls Fineco logout.

## Install

```sh
npm install
```

## Use

Pass your Fineco user id and password:

```sh
npm start -- "your-user-id" "your-password"
```

Or use 1Password CLI:

```sh
npm start -- --op-item "Fineco"
```

The default run writes:

```text
portfolio-report.html
```

and prints JSON to stdout.

## Output Formats

JSON is the default:

```sh
npm start -- "your-user-id" "your-password"
```

CSV:

```sh
FINECO_OUTPUT=csv npm start -- "your-user-id" "your-password"
```

Raw Fineco API response:

```sh
FINECO_OUTPUT=raw npm start -- "your-user-id" "your-password"
```

Change the report path:

```sh
FINECO_HTML_REPORT=my-report.html npm start -- "your-user-id" "your-password"
```

## 1Password

By default, `--op-item` reads fields named `username` and `password`.

If your item uses different field names:

```sh
FINECO_OP_USER_FIELD="codice utente" \
FINECO_OP_PASSWORD_FIELD="password" \
npm start -- --op-item "Fineco"
```

You can also use:

```sh
FINECO_OP_ITEM="Fineco" npm start
```

## Environment Variables

```text
FINECO_USER_ID          Fineco user id.
FINECO_PASSWORD         Fineco password.
FINECO_OP_ITEM          1Password item name.
FINECO_OP_USER_FIELD    1Password user id field. Default: username.
FINECO_OP_PASSWORD_FIELD 1Password password field. Default: password.
FINECO_HTML_REPORT      HTML report path. Default: portfolio-report.html.
FINECO_OUTPUT           json, csv, or raw. Default: json.
FINECO_DEBUG            Set to 1 for secret-safe request diagnostics.
FINECO_POSITIONS_URL    Override Fineco positions endpoint.
```

## Development

```sh
npm run typecheck
npm run format
npm run build
```

## Notes

This is an unofficial helper and is not affiliated with FinecoBank. Use it responsibly and make sure it fits Fineco's terms and your own security expectations.

## License

Apache-2.0
