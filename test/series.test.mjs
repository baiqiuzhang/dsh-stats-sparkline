/**
 * Series and chart maths — the metric discipline lives here.
 *
 * The load-bearing assertions: a ratio is pooled over the window (sum over
 * sum) and never averaged per sample; a counter is differentiated with respect
 * to time; and a window that outlives the retained samples still pools from the
 * session origin.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadBundle, sample, stubT } from './harness.mjs'

const { api } = loadBundle()
const internals = api.__internals
const t = stubT(internals.localeZH)

/** t0 + a zero sample, then request A (9990/10000 hit), then request B (0/10). */
function fixture() {
  const t0 = 1700000000000
  let series = internals.emptySeries()
  series = internals.appendSample(series, sample(t0, [0, 0, 0, 0], [0, 0]))
  series = internals.appendSample(series, sample(t0 + 1000, [10, 9990, 0, 50], [100, 500]))
  series = internals.appendSample(series, sample(t0 + 2000, [20, 9990, 0, 50], [180, 900]))
  return { t0, series }
}

test('token formatting matches the built-in stats line', () => {
  assert.equal(internals.formatTokens(517, t), '517')
  assert.equal(internals.formatTokens(1500, t), '1.5K')
  assert.equal(internals.formatTokens(12200, t), '12.2K')
  assert.equal(internals.formatTokens(1200000, t), '1.2M')
  assert.equal(internals.formatExactTokens(1234567, t), '1,234,567')
  assert.equal(internals.formatTokensPerSecond(9.44), '9.4')
  assert.equal(internals.formatTokensPerSecond(23.6), '24')
  assert.equal(internals.formatTokensPerSecond(-3), '0')
})

test('cache-hit percent never rounds a partial hit to 100', () => {
  assert.equal(internals.formatCacheHitPercent(0, 0), null)
  assert.equal(internals.formatCacheHitPercent(100, 100), '100')
  assert.equal(internals.formatCacheHitPercent(500, 1000), '50')
  assert.equal(internals.formatCacheHitPercent(99990, 100000), '99.99')
})

test('billing buckets add up the way the pill reads them', () => {
  const usage = { uncachedInputTokens: 10, cacheReadTokens: 9990, cacheWriteTokens: 0, outputTokens: 50 }
  assert.equal(internals.billedInput(usage), 10000)
  assert.equal(internals.totalTokens(usage), 10050)
})

test('appendSample appends, coalesces, resets on regression and caps the buffer', () => {
  const empty = internals.emptySeries()
  const first = internals.appendSample(empty, sample(1000, [1, 1, 0, 0], [0, 0]))
  assert.equal(first.samples.length, 1)
  assert.deepEqual(first.origin, first.samples[0])

  // Closer than COALESCE_MS: the newer observation replaces the older one.
  const coalesced = internals.appendSample(first, sample(1100, [2, 1, 0, 0], [0, 0]))
  assert.equal(coalesced.samples.length, 1)
  assert.equal(coalesced.samples[0].u[0], 2)

  const appended = internals.appendSample(first, sample(2000, [2, 1, 0, 0], [0, 0]))
  assert.equal(appended.samples.length, 2)
  assert.deepEqual(appended.origin, first.samples[0])

  // Counter rewind: the durable log was rewritten, so the series restarts.
  const reset = internals.appendSample(appended, sample(3000, [0, 0, 0, 0], [0, 0]))
  assert.equal(reset.samples.length, 1)
  assert.deepEqual(reset.origin, reset.samples[0])

  let series = internals.emptySeries()
  for (let index = 0; index < internals.MAX_SAMPLES + 120; index += 1) {
    series = internals.appendSample(series, sample(index * 1000, [index, 0, 0, 0], [0, 0]))
  }
  assert.equal(series.samples.length, internals.MAX_SAMPLES)
  assert.equal(series.origin.u[0], 0)
})

test('a ratio is pooled over the window, not averaged per sample', () => {
  const { series } = fixture()
  const points = internals.deriveWindowPoints(series, Infinity)
  const last = points[points.length - 1]

  // Request A: 9990 hit out of 10000 prompt. Request B: 0 hit out of 10.
  const pooled = (9990 / 10010) * 100
  const meanOfRatios = (99.9 + 0) / 2
  assert.ok(Math.abs(last.hit - pooled) < 0.001, `pooled hit must be ${pooled}, got ${last.hit}`)
  assert.ok(Math.abs(last.hit - meanOfRatios) > 40, 'per-sample mean must not be used')
  assert.ok(Math.abs(points[0].hit - 99.9) < 0.001)
})

test('a finite window pools only the samples inside it', () => {
  const { series } = fixture()
  const points = internals.deriveWindowPoints(series, 1000)
  const last = points[points.length - 1]
  // Window [-1000ms] covers request B alone: 0 cached of 10 prompt.
  assert.equal(last.hit, 0)
  assert.equal(last.full, false)

  const sessionWide = internals.deriveWindowPoints(series, 60000)
  assert.equal(sessionWide.every((point) => point.full === true), true)
})

test('the session origin survives buffer trimming', () => {
  const t0 = 1700000000000
  const origin = sample(t0, [0, 0, 0, 0], [0, 0])
  const series = {
    origin,
    samples: [sample(t0 + 100000, [10, 100, 0, 0], [0, 0]), sample(t0 + 101000, [20, 200, 0, 0], [0, 0])]
  }
  const points = internals.deriveWindowPoints(series, Infinity)
  const last = points[points.length - 1]
  assert.ok(Math.abs(last.hit - (200 / 220) * 100) < 0.001)
})

test('the token counter is differentiated over the pooled span', () => {
  const { series } = fixture()
  const points = internals.deriveWindowPoints(series, Infinity)
  const last = points[points.length - 1]
  // Δ prompt 10010 + Δ output 50 over 2000ms.
  assert.equal(last.deltaTokens, 10060)
  assert.equal(last.tokenRate, (10060 / 2000) * 1000)
  // Decode speed is pooled too: Δdecode 900 tokens over Δdecode 180ms.
  assert.equal(last.speed, (900 / 180) * 1000)
})

test('the live speed pools the trailing window, not the whole session', () => {
  const t0 = 1700000000000
  let series = internals.emptySeries()
  // An old, fast step: 900 tokens over 180ms = 5000 tok/s.
  series = internals.appendSample(series, sample(t0, [0, 0, 0, 0], [0, 0]))
  series = internals.appendSample(series, sample(t0 + 1000, [0, 0, 0, 900], [180, 900]))
  // Much later, one slow step INSIDE the live window: 60 tokens over 2000ms.
  series = internals.appendSample(series, sample(t0 + 600000, [0, 0, 0, 960], [2180, 960]))
  const live = internals.liveSpeed(series, internals.LIVE_WINDOW_MS)
  assert.ok(Math.abs(live - 30) < 1e-9, `live must be the recent rate, got ${live}`)
  // The session average is a different figure: that is exactly why the pill
  // had to stop reading it — it would still say 440 tok/s here.
  const average = (960 / 2180) * 1000
  assert.ok(Math.abs(average - live) > 100, `average ${average} must differ from live ${live}`)
})

test('the live speed holds the last measured step while the window is quiet', () => {
  const t0 = 1700000000000
  let series = internals.emptySeries()
  series = internals.appendSample(series, sample(t0, [0, 0, 0, 0], [0, 0]))
  series = internals.appendSample(series, sample(t0 + 1000, [0, 0, 0, 500], [200, 500]))
  // Ten minutes of heartbeat samples with no decoding (a long tool call).
  series = internals.appendSample(series, sample(t0 + 600000, [0, 0, 0, 500], [200, 500]))
  assert.equal(internals.liveSpeed(series, internals.LIVE_WINDOW_MS), (500 / 200) * 1000)
})

test('the live speed is null until some step has decoded', () => {
  assert.equal(internals.liveSpeed(internals.emptySeries(), internals.LIVE_WINDOW_MS), null)
  const t0 = 1700000000000
  const single = internals.appendSample(internals.emptySeries(), sample(t0, [10, 0, 0, 0], [0, 0]))
  assert.equal(internals.liveSpeed(single, internals.LIVE_WINDOW_MS), null)
})

test('a window with no new prompt tokens has no hit ratio', () => {
  const t0 = 1700000000000
  let series = internals.emptySeries()
  series = internals.appendSample(series, sample(t0, [10, 0, 0, 0], [0, 0]))
  series = internals.appendSample(series, sample(t0 + 5000, [10, 0, 0, 0], [0, 0]))
  const last = internals.deriveWindowPoints(series, Infinity).pop()
  assert.equal(last.hit, null)
  assert.equal(last.tokenRate, 0)
})

test('downsampling keeps null gaps and honours the point budget', () => {
  const points = []
  for (let index = 0; index < 300; index += 1) {
    points.push({
      t: index * 1000,
      spanMs: 1000,
      full: false,
      deltaTokens: 0,
      hit: null,
      cumulativeHit: 50,
      tokenRate: 0,
      speed: null,
      // Buckets pool from these deltas; all-zero deltas keep the gap a gap.
      d: [0, 0, 0, 0],
      ds: [0, 0]
    })
  }
  const pooled = internals.downsample(points, internals.MAX_POINTS)
  assert.equal(pooled.length, internals.MAX_POINTS)
  assert.equal(pooled.every((point) => point.hit === null), true)
  assert.equal(pooled.every((point) => point.cumulativeHit === 50), true, 'a level takes the bucket tail')
  assert.equal(internals.downsample(points.slice(0, 10), internals.MAX_POINTS).length, 10)
})

test('downsampling pools ratios instead of averaging them', () => {
  // One 100%-cached request of 9990 prompt tokens and one fully-missed request
  // of 10: the pooled bucket is 99.9%; an unweighted mean would say 50%.
  const heavy = { t: 1000, spanMs: 1000, full: false, deltaTokens: 9990, cumulativeHit: 99.9, d: [0, 9990, 0, 0], ds: [0, 0] }
  const light = { t: 2000, spanMs: 1000, full: false, deltaTokens: 10, cumulativeHit: 99.8, d: [10, 0, 0, 0], ds: [0, 0] }
  const [bucket] = internals.downsample([heavy, light], 1)
  assert.ok(Math.abs(bucket.hit - (9990 / 10000) * 100) < 0.001, `pooled hit was ${bucket.hit}`)
  assert.equal(Math.abs(bucket.hit - 50) > 40, true, 'the unweighted mean must not be used')
  // Rates stay span-weighted: Σdelta / Σspan.
  assert.equal(bucket.tokenRate, ((9990 + 10) / 2000) * 1000)
  assert.equal(bucket.cumulativeHit, 99.8)
})

test('the chart model carries both tabs and reports starved data', () => {
  const { series } = fixture()
  const hit = internals.buildChartModel(series, Infinity, 'hit', t)
  assert.equal(hit.empty, false)
  assert.equal(hit.y1, 100)
  // The fixture's ratios sit at 99.8–99.9%: a 0–100 axis would flatten them, so
  // the band is fitted and the footer says so.
  assert.equal(hit.y0, 99)
  assert.equal(hit.zoomed, true)
  assert.equal(hit.yBottomLabel, '99%')
  assert.equal(hit.yTopLabel, '100%')
  assert.equal(hit.series.length, 2)
  assert.equal(hit.series[0].key, 'hit')
  assert.equal(hit.series[1].key, 'cumulative')
  assert.equal(hit.series[0].segments.length > 0, true)
  assert.equal(hit.xStartLabel, '起点')
  assert.equal(hit.lastDot !== null, true)
  assert.match(hit.foot, /窗口/)
  assert.match(hit.foot, /纵轴 99–100%/)

  const rate = internals.buildChartModel(series, Infinity, 'rate', t)
  assert.equal(rate.empty, false)
  assert.equal(rate.series[0].key, 'rate')
  assert.equal(rate.series[1].key, 'speed')
  assert.ok(rate.y1 >= 1)
  // Peaks of 2:1 keep one shared scale; a split only happens past the ratio.
  assert.equal(rate.dual, false)
  assert.equal(rate.rightLabels, null)
  assert.equal(rate.padRight, internals.CHART_PAD_RIGHT)

  const starved = internals.buildChartModel(internals.emptySeries(), 60000, 'hit', t)
  assert.equal(starved.empty, true)
  assert.equal(starved.points.length, 0)
})

/** Steady stream: ~10k tok/s consumption against a flat 50 tok/s decode. */
function wideGapSeries() {
  const t0 = 1700000000000
  let series = internals.emptySeries()
  series = internals.appendSample(series, sample(t0, [0, 0, 0, 0], [0, 0]))
  series = internals.appendSample(series, sample(t0 + 5000, [45000, 0, 0, 5000], [5000, 250]))
  series = internals.appendSample(series, sample(t0 + 10000, [90000, 0, 0, 10000], [10000, 500]))
  series = internals.appendSample(series, sample(t0 + 15000, [140000, 0, 0, 15000], [15000, 750]))
  return series
}

test('a 100x magnitude gap moves the small line to a second axis', () => {
  const model = internals.buildChartModel(wideGapSeries(), Infinity, 'rate', t)
  assert.equal(model.dual, true)
  assert.equal(model.series.find((line) => line.key === 'rate').side, 'left')
  assert.equal(model.series.find((line) => line.key === 'speed').side, 'right')
  // The right gutter widens to carry the second axis's labels.
  assert.equal(model.padRight, internals.CHART_PAD_RIGHT_DUAL)
  assert.equal(model.rightLabels !== null, true)
  assert.equal(model.rightLabels.length, 3)
  assert.equal(model.leftLabels.length, 3)
  // Each side carries its own scale: thousands (K) on the left, dozens on the
  // right — the whole point of the second axis.
  assert.equal(model.leftLabels.every((label) => label.text.endsWith('K')), true, `left labels: ${model.leftLabels.map((l) => l.text)}`)
  assert.equal(model.rightLabels.every((label) => label.text.endsWith('K') === false), true, `right labels: ${model.rightLabels.map((l) => l.text)}`)
  assert.equal(Number(model.rightLabels[0].text) <= 100, true, `right labels: ${model.rightLabels.map((l) => l.text)}`)
  // Long-term steady rates zoom the left axis too (small variation stays legible).
  assert.equal(model.y0 > 0, true)
  // The footer names both scales, and the legend tags the moved line.
  assert.match(model.foot, /二号轴/)
  assert.equal(internals.sideTag(model, 'speed', t), '（右轴）')
  assert.equal(internals.sideTag(model, 'rate', t), null)
})

test('the breakdown view gives a small output line its own axis', () => {
  const t0 = 1700000000000
  let series = internals.emptySeries()
  series = internals.appendSample(series, sample(t0, [0, 0, 0, 0], [0, 0]))
  series = internals.appendSample(series, sample(t0 + 5000, [20000, 25000, 0, 3000], [0, 0]))
  series = internals.appendSample(series, sample(t0 + 10000, [40000, 50000, 0, 6000], [0, 0]))
  const model = internals.buildChartModel(series, Infinity, 'split', t)
  assert.equal(model.dual, true)
  assert.equal(model.series.map((line) => line.key).join(','), 'cache,input,output')
  assert.equal(model.series.find((line) => line.key === 'cache').side, 'left')
  assert.equal(model.series.find((line) => line.key === 'input').side, 'left')
  assert.equal(model.series.find((line) => line.key === 'output').side, 'right')
  assert.match(model.foot, /二号轴/)
})

test('every view zooms its left axis when the data sits far from zero', () => {
  const { series } = fixture()
  const views = [
    { view: 'hit', model: internals.buildChartModel(series, Infinity, 'hit', t) },
    { view: 'rate', model: internals.buildChartModel(wideGapSeries(), Infinity, 'rate', t) },
    { view: 'split', model: internals.buildChartModel(wideGapSeries(), Infinity, 'split', t) }
  ]
  for (const entry of views) {
    assert.equal(entry.model.y0 > 0, true, `${entry.view}: left axis must zoom (y0=${entry.model.y0})`)
    assert.match(entry.model.foot, /纵轴/, `${entry.view}: the footer must state the scale`)
  }
})

test('window presets resolve to milliseconds, and back to their own label', () => {
  assert.equal(internals.windowMsOf('30s'), 30000)
  assert.equal(internals.windowMsOf('1m'), 60000)
  assert.equal(internals.windowMsOf('5m'), 300000)
  assert.equal(internals.windowMsOf('session'), Infinity)
  assert.equal(internals.windowMsOf('nonsense'), 60000)
  // The chart labels the preset that actually pooled the data.
  assert.equal(internals.windowIdOf(30000), '30s')
  assert.equal(internals.windowIdOf(60000), '1m')
  assert.equal(internals.windowIdOf(300000), '5m')
  assert.equal(internals.windowIdOf(Infinity), 'session')
  assert.equal(internals.windowIdOf(12345), internals.DEFAULT_WINDOW_ID)
})

test('each preset names itself in the summary, footer and axis', () => {
  // 2 minutes of samples: wide enough that a 30s window is genuinely narrower
  // than the session, so the left axis shows a real "-30秒" span.
  const t0 = 1700000000000
  let series = internals.emptySeries()
  series = internals.appendSample(series, sample(t0, [0, 0, 0, 0], [0, 0]))
  series = internals.appendSample(series, sample(t0 + 60000, [100, 900, 0, 50], [1000, 400]))
  series = internals.appendSample(series, sample(t0 + 120000, [200, 1800, 0, 100], [2000, 800]))

  const half = internals.buildChartModel(series, 30000, 'rate', t)
  assert.match(half.foot, /窗口 30秒/)
  assert.equal(half.foot.includes('1分'), false, 'a 30s window must not claim 1m')
  assert.equal(half.xStartLabel, '-30秒')

  const five = internals.buildChartModel(series, 300000, 'rate', t)
  assert.match(five.foot, /窗口 5分/)
  assert.equal(five.foot.includes('1分'), false)

  const minute = internals.buildChartModel(series, 60000, 'hit', t)
  assert.match(minute.summary, /窗口 1分/)

  const session = internals.buildChartModel(series, Infinity, 'hit', t)
  assert.match(session.summary, /窗口 全程/)
  assert.equal(session.xStartLabel, '起点')
})

test('a hostile counter cannot hang or throw the formatter', () => {
  // The precision loop divides a negative gap by ten forever if the host reports
  // an oversized cache-read bucket; the guard returns before it starts.
  assert.equal(internals.formatCacheHitPercent(200, 100), '100')
  // A negative bucket is nonsense: bounded work, and the reading stays sane.
  assert.equal(internals.formatCacheHitPercent(-5, 100), '0')
  assert.equal(internals.formatCacheHitPercent(50, 100), '50')
  assert.equal(internals.formatCacheHitPercent(0, 100), '0')
})

test('the breakdown tab differentiates each token bucket over the span', () => {
  const { series } = fixture()
  const points = internals.deriveWindowPoints(series, Infinity)
  const last = points[points.length - 1]
  // fixture: t0 [0,0,0,0] → t0+2000 [20 uncached, 9990 cached, 0 write, 50 out]
  assert.equal(last.inputRate, (20 / 2000) * 1000)
  assert.equal(last.cacheRate, (9990 / 2000) * 1000)
  assert.equal(last.outputRate, (50 / 2000) * 1000)

  const model = internals.buildChartModel(series, Infinity, 'split', t)
  assert.equal(model.empty, false)
  assert.equal(model.series.map((line) => line.key).join(','), 'cache,input,output')
  assert.equal(model.series.length, 3)
  assert.equal(model.yTopLabel.includes('%'), false, 'the breakdown axis counts tokens per second')
  assert.match(model.summary, /输入/)
  assert.equal(model.series[0].segments.length > 0, true)
})

test('the y band is chosen per quantity, not fixed at 0–100', () => {
  // Ratios live against a ceiling: a healthy hit share is 90–100%, and a fixed
  // 0–100 axis draws it as a flat line pinned to the top.
  const ceiling = internals.fitAxis([99.9, 99.8, 100], { mode: 'percent' })
  assert.equal(ceiling.y1, 100)
  assert.equal(ceiling.y0, 99)
  assert.equal(ceiling.y1 - ceiling.y0 >= 1, true)

  const mid = internals.fitAxis([97.2, 99.8], { mode: 'percent' })
  assert.equal(mid.y0 <= 97.2, true)
  assert.equal(mid.y1, 100)

  // A wide ratio swing keeps the honest full band.
  const wide = internals.fitAxis([0, 100], { mode: 'percent' })
  assert.equal(wide.y0, 0)
  assert.equal(wide.y1, 100)

  // A perfectly flat ratio still gets a readable band, never a zero-height one.
  const flat = internals.fitAxis([98, 98], { mode: 'percent' })
  assert.equal(flat.y1 - flat.y0 >= 1, true)
  assert.equal(flat.y0 <= 98 && flat.y1 >= 98, true)

  // Rates keep the zero baseline while they actually reach for it: idle gaps
  // falling to 0 tok/s carry information.
  const spiky = internals.fitAxis([0, 2000], { mode: 'rate' })
  assert.equal(spiky.y0, 0)
  assert.equal(spiky.y1 >= 2000, true)
  const baseline = internals.fitAxis([40, 400], { mode: 'rate' })
  assert.equal(baseline.y0, 0, 'a peak far above the baseline keeps 0')

  // A steady stream well above zero is otherwise just as flat as a ratio.
  const steady = internals.fitAxis([40, 55], { mode: 'rate' })
  assert.equal(steady.y0 > 0, true)
  assert.equal(steady.y0 <= 40 && steady.y1 >= 55, true)
  assert.equal(steady.y0, 30)
  assert.equal(steady.y1, 60)

  // Degenerate inputs never produce a zero-height, inverted or NaN window.
  const single = internals.fitAxis([50], { mode: 'rate' })
  assert.equal(Number.isFinite(single.y0) && Number.isFinite(single.y1), true)
  assert.equal(single.y1 > single.y0, true)
  const empty = internals.fitAxis([], { mode: 'percent' })
  assert.equal(empty.y0, 0)
  assert.equal(empty.y1, 100)
  const noNumber = internals.fitAxis([null, undefined], { mode: 'rate' })
  assert.equal(noNumber.y0, 0)
  assert.equal(noNumber.y1, 1)
})

test('axis steps and percent labels stay readable', () => {
  assert.equal(internals.niceStep(0.45), 0.5)
  assert.equal(internals.niceStep(1.4), 2)
  assert.equal(internals.niceStep(7.5), 10)
  assert.equal(internals.niceStep(70), 100)
  assert.equal(internals.percentText(99), '99')
  assert.equal(internals.percentText(100), '100')
  assert.equal(internals.percentText(97.25), '97.3')
  assert.equal(internals.percentText(98.5), '98.5')
})
