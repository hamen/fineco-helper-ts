# fineco-helper

A small local helper for exporting your Fineco portfolio positions as JSON, CSV, raw API JSON, a clean HTML report, or shareable reports that hide actual values.

![Example report using fake demo data](docs/example-report.svg)

## Privacy First

`fineco-helper` is intentionally boring about data:

- It runs locally on your machine.
- It does not store your Fineco username or password.
- It does not send your portfolio data to any third-party service.
- It only talks to Fineco endpoints needed to log in, fetch positions, and log out.
- Output goes to stdout by default, or to a local file when you pass `--out`.

Credentials are read from command-line arguments, environment variables, or the 1Password CLI. They are used for the login request and are not printed.

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

By default, `fineco-helper` prints compact portfolio JSON to stdout.

## Formats

JSON summary and rows:

```sh
npm start -- "your-user-id" "your-password" --format json
```

CSV:

```sh
npm start -- "your-user-id" "your-password" --format csv
```

Raw Fineco API response:

```sh
npm start -- "your-user-id" "your-password" --format raw
```

HTML report to stdout:

```sh
npm start -- "your-user-id" "your-password" --format html
```

HTML report to a file:

```sh
npm start -- "your-user-id" "your-password" --format html --out portfolio-report.html
```

Shareable HTML report, omitting quantities, prices, market values, book values, and absolute profit/loss:

```sh
npm start -- "your-user-id" "your-password" --format shareable-html > shareable-report.html
```

Shareable CSV for machine use, with only instrument identity, type/venue/currency, portfolio weight %, and P/L %:

```sh
npm start -- "your-user-id" "your-password" --format shareable-csv > shareable-positions.csv
```

Because output is stdout-first, normal shell composition works too:

```sh
npm start -- --op-item "Fineco" --format html > portfolio-report.html
npm start -- --op-item "Fineco" --format csv > positions.csv
npm start -- --op-item "Fineco" --format shareable-csv > shareable-positions.csv
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

The CLI should cover normal use. These env vars are available for credentials and uncommon tweaks:

```text
FINECO_USER_ID           Fineco user id.
FINECO_PASSWORD          Fineco password.
FINECO_OP_ITEM           1Password item name.
FINECO_OP_USER_FIELD     1Password user id field. Default: username.
FINECO_OP_PASSWORD_FIELD 1Password password field. Default: password.
FINECO_OUTPUT            json, raw, csv, html, shareable-html, or shareable-csv. Default: json.
FINECO_DEBUG             Set to 1 for secret-safe request diagnostics.
FINECO_POSITIONS_URL     Override Fineco positions endpoint.
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
