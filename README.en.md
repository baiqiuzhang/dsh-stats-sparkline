# dsh-stats-sparkline

**[中文](README.md) | English**

A DSH Web GUI plugin that turns two composer-row statistics into live sparklines:

1. **Shadow the official stats cell** — on hover it shows a time series in addition to the numbers.
2. **Add a token-composition chip** (input / cache / output) with the same hover chart.

Data comes from the host's built-in projections only — `tokenUsage` and `sessionStats`. The plugin adds no collection channel and writes nothing to `$DSH_HOME`.

## Install

```
dsh plugin --profile desktop add https://github.com/baiqiuzhang/dsh-stats-sparkline/releases/download/v1.0.0/dsh-stats-sparkline-1.0.0.tgz
```

Restart DSH after installing (the client bundle is resolved at startup).

## How it works

- Subscribes to `useProjection('tokenUsage')` and `useProjection('sessionStats')`.
- Samples on projection change plus a 5 s heartbeat; keeps 720 samples per session in memory, mirrors up to 300 into `sessionStorage` so a page refresh does not lose the curve.
- A counter rollback (revert / branch replay) restarts the series instead of drawing a negative delta.

## Limits

- Read-only: it never adds a new data source.
- The composer dock is a list slot; the plugin occupies specific slot ids and may need an update if the host renames them.
- Tests live in `test/` and are not shipped in the npm tarball.

## License

MIT
