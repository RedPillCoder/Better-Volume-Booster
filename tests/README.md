# Tests

Three layers, all runnable from this directory:

## Requirements
- Node.js 18+ and `npm install` here (installs `jsdom` for the DOM tests).
- Python 3 with `pip install marionette_driver` (e2e only).
- Firefox (any recent build; ESR is fine). The e2e auto-detects `firefox-esr`
  or `firefox`; set `FIREFOX_BIN=/path/to/firefox` to override. It runs
  headless and never touches your real browser profile.

## Run
```
node unit.test.js        # 35 tests: storage routing, rule lifecycles, validation, containers...
node dom.test.js         # 12 tests: popup/options wiring (jsdom + mocked browser API)

python3 serve.py &       # local media servers on :8000 / :8001 (two origins)
python3 e2e_marionette.py  # 17 checks in a real Firefox (boosting, scoped CORS, iframes, restarts...)
```

The e2e installs the extension from the repository root (`..`) into a throwaway
profile; it never touches your real browser profile.
