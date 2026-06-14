# Browser Agent

Optional HTTP worker for `browser.automation` and `browser.ui-test`.

The Phase 3 image intentionally contains no Chromium or Playwright. Its API and
authentication boundary are ready, but `/agent/run` returns
`BROWSER_RUNTIME_NOT_IMPLEMENTED` until a browser runtime is added to this
separate image.

Start with:

```bash
docker compose --profile browser up -d
```

