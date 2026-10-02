# y2k-cam
A retro web camera featuring realtime ASCII art and GameBoy 8-bit pixel filters.

## Local preview

Serve the folder with a static server, for example `python3 -m http.server 8000`, then open `http://localhost:8000`. Camera access requires localhost or HTTPS.

## Validation

Run `node --test tests/*.test.cjs` with Node 20 or later. These tests mock media devices and verify lifecycle behavior; real camera capture, encoding, sharing, and mobile safe areas require hardware validation.

See [the design review](docs/design-review.md) for guideline mapping and the device checklist.
