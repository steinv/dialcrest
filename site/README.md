# Dialcrest marketing site

The static site (home, FAQ, privacy policy) served by Firebase Hosting, built
with [Vite](https://vite.dev).

## Layout

- `index.html`, `faq.html`, `privacy.html` — the pages (Vite's multi-page
  entry points, configured in `vite.config.js`).
- `style.css`, `script.js`, `images/` — referenced from the pages above; Vite
  fingerprints these with a content hash on build (e.g. `style-a1b2c3.css`),
  which is what lets `firebase.json` cache them forever
  (`Cache-Control: immutable`) without ever serving stale content.
- `public/` — files copied to the output **as-is, unhashed**: favicons,
  `site.webmanifest`, `robots.txt`, `sitemap.xml`. These are referenced by
  fixed/conventional paths, so they must not be renamed.

Build output goes to `dist/` at the repo root, which is what
`firebase.json`'s `hosting.public` points at — never edit `dist/` by hand.

## Getting started

```bash
npm install
```

## Local development

```bash
npm run dev
```

Starts the Vite dev server with hot reload at the printed localhost URL.

## Build

```bash
npm run build
```

Produces the hashed, production-ready site in `../dist`. To check it locally
exactly as Firebase will serve it (same headers, same rewrites):

```bash
firebase emulators:start --only hosting
```

## Deploy

From the repo root:

```bash
firebase deploy --only hosting
```

`firebase.json` runs this build automatically as a `predeploy` step, so this
one command builds and deploys — no manual `npm run build` needed first.
