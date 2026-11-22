/**
 * dsh-stats-sparkline — browser half.
 *
 * Shadows the built-in composer stat cells (`conversation.composer.dock`,
 * `id: 'activity'` and `id: 'usage'`, both at `priority: -1`) and repaints the
 * same two pills, adding a time-series chart to both stat dialogs. The official
 * entries stay registered at priority 0 and come back by themselves if this
 * entry abdicates.
 *
 * The tok/s reading on the activity pill is LIVE (see {@link LIVE_WINDOW_MS}):
 * it pools the decode rate over the trailing window instead of dividing the
 * session's whole decode time into its whole output count, which never moves
 * again once a session has a few steps behind it.
 *
 * Metric discipline (the point of the plugin):
 *   - RATIOS (cache-hit share, output speed) are window-POOLED ratios: the
 *     numerator and the denominator are each summed over the window, and only
 *     then divided. Per-sample ratios are never averaged and a ratio is never
 *     differentiated — on counters, a mean of per-sample ratios is dominated by
 *     tiny requests (9990/10000 then 0/10 pools to 99.80%, while the mean of
 *     the two ratios is 49.95%).
 *   - COUNTERS (total tokens) ARE differentiated with respect to time, which is
 *     the only way a cumulative quantity can show how it changes: the chart
 *     plots window-pooled tok/s, not the running total.
 *
 * Bundle format: a classic-script closure factory, exactly as the official
 * `packages/preset/agent-preset/skills/cordis-plugin-development/templates/
 * decoration/client.js` prescribes — no import/export statements, React comes
 * from the browser module table. This file is its own build product.
 */
// Outside a browser (node tooling, SSR import) stay inert instead of throwing;
// inside a browser without the loader, fail loudly: that is a broken DSH
// installation, not a plugin bug.
const sparkModuleLoader = typeof window === 'undefined' ? undefined : window.__ModuleLoader__
if (sparkModuleLoader !== undefined) {
  sparkModuleLoader.load({
  id: 'dsh-stats-sparkline',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    /** Host primitives are optional: without them the plugin degrades, not dies. */
    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    } catch (error) {
      primitives = {}
    }

    /* ------------------------------------------------------------------ *
     * Identity and tuning
     * ------------------------------------------------------------------ */

    /** Client locale namespace; must match the loader row id in cordis.patch.yml. */
    const NS = 'dsh-stats-sparkline'
    /**
     * Claim dsh-cost-meter's composer line and render nothing there.
     *
     * That line reads `本会话 ¥x · 命中 P% · 输入 · 缓存 · 输出`, so its hit rate
     * duplicates the token pill on its left and its three token buckets duplicate
     * this plugin's chip. Claiming the cell is the same official shadowing
     * mechanism used for the built-in stats cell (same id, lower priority), so
     * cost-meter's line returns untouched the moment this plugin is disabled;
     * only its money reading leaves the row (it still lives in cost-meter's
     * sidebar card). Set to false to leave that line alone.
     */
    const SUPPRESS_COST_METER_LINE = true
    /**
     * Historical switch, kept as a documented no-op: older dsh-cost-meter builds
     * painted a second 轮/步/tok/s pill row in the composer dock under
     * `cost-meter-statistics`. 1.9.58 registers that id in
     * `conversation.session.header.actions` instead and paints its dock row under
     * `cost-meter`, which {@link SUPPRESS_COST_METER_LINE} already claims. Keeping
     * the claim costs one empty cell and covers a downgrade; it shadows nothing
     * today because the composer dock has no such id.
     */
    const SUPPRESS_COST_METER_STATS = true
    /** Hover opens a dialog without a click (the built-in pills are click-only). */
    const HOVER_OPEN = true
    const HOVER_OPEN_DELAY_MS = 180
    const HOVER_CLOSE_DELAY_MS = 250
    /**
     * Trailing window of the LIVE tok/s reading on the activity pill.
     *
     * The pill must answer "how fast is it decoding now", not "how fast did this
     * session average out" — a session average stops moving after the first few
     * steps and therefore cannot show a stall, a burst, or a rate that changed
     * when the model switched. `sessionStats.decodeMs` / `decodeTokens` fold
     * COMMITTED `step/end` events, so the finest honest reading is "the decode
     * rate pooled over the steps that finished inside this window" (ΣΔtokens /
     * ΣΔdecode-ms, never a mean of per-step ratios). A single long generation
     * therefore refreshes the number when that step ends, not per token.
     */
    const LIVE_WINDOW_MS = 30000
    /** Heartbeat sampling cadence while the composer row is mounted. */
    const SAMPLE_INTERVAL_MS = 5000
    /** Samples closer together than this replace each other instead of appending. */
    const COALESCE_MS = 250
    /** Retained cumulative samples per session (newest kept). */
    const MAX_SAMPLES = 720
    /** Sessions kept in the in-memory series cache. */
    const MAX_SESSIONS = 8
    /** Points drawn after bucket-averaging. */
    const MAX_POINTS = 96
    /** Chart box: 264 wide keeps the panel at its native 300px min-width. */
    const CHART_WIDTH = 264
    const CHART_HEIGHT = 72
    const CHART_PAD_LEFT = 26
    /** Right gutter: label width when a second axis is present, else a margin. */
    const CHART_PAD_RIGHT = 4
    const CHART_PAD_RIGHT_DUAL = 26
    const CHART_PAD_TOP = 6
    const CHART_PAD_BOTTOM = 13
    /**
     * A line whose peak is below 1/AXIS_SPLIT_RATIO of the chart's largest peak
     * moves to the right-hand axis; at 1:1 or 1:2 they still share one scale.
     */
    const AXIS_SPLIT_RATIO = 4
    /** Placement of the portaled dialog (mirrors ui-chat's stat-dialog.ts). */
    const PANEL_MARGIN = 12
    const PANEL_GAP = 8
    /** Unplaced portal panel: hidden but laid out so the clamp can measure it. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }
    /** Degraded seat when the anchored-position primitive is unavailable. */
    const INLINE_PANEL_STYLE = { position: 'absolute', bottom: '100%', left: 0, marginBottom: '8px' }
    /** Rolling-window presets; `ms: Infinity` pools the whole session. */
    const WINDOWS = [
      { id: '30s', ms: 30000 },
      { id: '1m', ms: 60000 },
      { id: '5m', ms: 300000 },
      { id: 'session', ms: Infinity }
    ]
    const DEFAULT_WINDOW_ID = '1m'
    const PERSIST_PREFIX = 'dsh-stats-sparkline:v1:'
    const WINDOW_KEY = `${PERSIST_PREFIX}window`
    /** Cumulative samples persisted per session (sessionStorage is ~5MB total). */
    const PERSIST_SAMPLES = 300
    const PERSIST_THROTTLE_MS = 2000
    /** Line/skin palette taken from host theme tokens. */
    const COLOR_BRAND = 'var(--dsw-alias-brand-primary)'
    const COLOR_MUTED = 'var(--dsw-alias-label-tertiary)'
    const COLOR_SECONDARY = 'var(--dsw-alias-label-secondary)'
    /** Composition tab: cache reads read as a win, output as a distinct series. */
    const COLOR_SUCCESS = 'var(--dsw-alias-state-success-primary)'
    const COLOR_WARN = 'var(--dsw-alias-state-warn-primary)'

    /* ------------------------------------------------------------------ *
     * Optional host surface — guarded so a renamed export degrades, never throws
     * ------------------------------------------------------------------ */

    const HAS_ANCHOR_API = typeof primitives.useAnchoredPosition === 'function'
    const useAnchoredPosition = HAS_ANCHOR_API
      ? primitives.useAnchoredPosition
      : function useNoAnchor() {
          return null
        }
    const useDismissOnOutsidePointer =
      typeof primitives.useDismissOnOutsidePointer === 'function'
        ? primitives.useDismissOnOutsidePointer
        : function useNoDismiss() {}
    const IconGauge = primitives.IconGaugeOutlineRegular || null
    const IconDatabase = primitives.IconDatabaseOutlineRegular || null

    /** ReactDOM portal; absent only if the module table withholds react-dom. */
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (reactDom !== null && typeof reactDom.createPortal === 'function') createPortal = reactDom.createPortal
    } catch (error) {
      createPortal = null
    }
    const HAS_DOCUMENT = typeof document !== 'undefined' && document !== null
    // The panel is `position:fixed`, so portalling it to <body> needs react-dom
    // only — not the host's anchored-position primitive. Requiring both here is
    // what used to drop the panel back inline inside the composer dock, where
    // the dock's clipping box left three quarters of it blank.
    const PORTAL = createPortal !== null && HAS_DOCUMENT

    /* ------------------------------------------------------------------ *
     * Locale dictionaries (wording mirrors ui-chat so the pills read alike)
     * ------------------------------------------------------------------ */

    const ZH = {
      counts: '{turns} 轮 {steps} 步',
      cacheHit: '缓存命中 {percent}%',
      tokensPerSecond: '{tps} tok/s',
      tokenCount: '{count} tok',
      thousand: '{value}K',
      million: '{value}M',
      groupSeparator: ',',
      dialogTitle: '会话统计',
      dialogUsageTitle: 'Token 用量',
      dialogLlmTime: '模型用时',
      dialogToolTime: '工具调用用时',
      dialogTtft: '首 token 平均（TTFT）',
      dialogSpeedLive: '输出速度（最近 {seconds} 秒）',
      dialogSpeedAverage: '输出速度（本会话平均）',
      turnUsageCacheHit: '缓存命中',
      turnUsageInput: '未缓存输入',
      turnUsageCacheRead: '缓存读取',
      turnUsageCacheWrite: '缓存写入',
      turnUsageOutput: '输出',
      compactSeconds: '{seconds}秒',
      compactMinutes: '{minutes}分{seconds}秒',
      windowAria: '时间窗口 {window}',
      windowGroup: '趋势时间窗口',
      percentValue: '{percent}%',
      window30s: '30秒',
      window1m: '1分',
      window5m: '5分',
      windowSession: '全程',
      axisNow: '现在',
      axisSince: '起点',
      chartLegendHit: '窗口命中率',
      chartLegendCumulative: '会话累计',
      chartLegendRate: '消耗速率',
      chartLegendSpeed: '输出速度',
      chartStarved: '已采集 {count} 个样本，再等一步就有曲线',
      chartSummaryHit: '窗口 {window}：窗口命中率 {hit}%，会话累计 {cumulative}%',
      chartSummaryRate: '窗口 {window}：消耗速率 {rate} tok/s，输出速度 {speed} tok/s',
      chartFootHit: '窗口 {window} · 会话累计 {cumulative}%',
      chartFootAxisPercent: '纵轴 {min}–{max}%',
      chartFootAxisRate: '纵轴 {min}–{max}',
      chartFootAxisDual: '纵轴 左 {left} · 右(二号轴) {right}',
      axisRightMark: '（右轴）',
      chartFootRate: '窗口 {window} · +{delta} tok · {seconds}s',
      chartLegendInput: '输入',
      chartLegendCache: '缓存',
      chartLegendOutput: '输出',
      chartSummarySplit: '窗口 {window}：输入 {input} tok/s，缓存 {cache} tok/s，输出 {output} tok/s',
      chipTitle: 'Token 构成',
      chipLine: '输入 {input} · 缓存 {cache} · 输出 {output}',
      chipSummary: '本会话 {total}：输入 {input} · 缓存 {cache} · 输出 {output}',
      chartNoData: '—'
    }

    const EN = {
      counts: '{turns} turns {steps} steps',
      cacheHit: 'Cache hit {percent}%',
      tokensPerSecond: '{tps} tok/s',
      tokenCount: '{count} tok',
      thousand: '{value}K',
      million: '{value}M',
      groupSeparator: ',',
      dialogTitle: 'Session statistics',
      dialogUsageTitle: 'Token usage',
      dialogLlmTime: 'LLM time',
      dialogToolTime: 'Tool time',
      dialogTtft: 'Avg time to first token (TTFT)',
      dialogSpeedLive: 'Output speed (last {seconds}s)',
      dialogSpeedAverage: 'Output speed (session average)',
      turnUsageCacheHit: 'Cache hit',
      turnUsageInput: 'Uncached input',
      turnUsageCacheRead: 'Cached input',
      turnUsageCacheWrite: 'Cache write',
      turnUsageOutput: 'Output',
      compactSeconds: '{seconds}s',
      compactMinutes: '{minutes}m{seconds}s',
      windowAria: 'Time window {window}',
      windowGroup: 'Trend time window',
      percentValue: '{percent}%',
      window30s: '30s',
      window1m: '1m',
      window5m: '5m',
      windowSession: 'All',
      axisNow: 'now',
      axisSince: 'start',
      chartLegendHit: 'Window hit rate',
      chartLegendCumulative: 'Session total',
      chartLegendRate: 'Consumption rate',
      chartLegendSpeed: 'Output speed',
      chartStarved: '{count} samples collected; one more step draws the curve',
      chartSummaryHit: 'Window {window}: hit rate {hit}%, session total {cumulative}%',
      chartSummaryRate: 'Window {window}: consumption {rate} tok/s, output {speed} tok/s',
      chartFootHit: 'Window {window} · session {cumulative}%',
      chartFootAxisPercent: 'axis {min}–{max}%',
      chartFootAxisRate: 'axis {min}–{max}',
      chartFootAxisDual: 'axis left {left} · right (2nd) {right}',
      axisRightMark: ' (right axis)',
      chartFootRate: 'Window {window} · +{delta} tok · {seconds}s',
      chartLegendInput: 'Input',
      chartLegendCache: 'Cache',
      chartLegendOutput: 'Output',
      chartSummarySplit: 'Window {window}: input {input} tok/s, cache {cache} tok/s, output {output} tok/s',
      chipTitle: 'Token breakdown',
      chipLine: 'In {input} · Cache {cache} · Out {output}',
      chipSummary: 'Session {total}: input {input} · cache {cache} · output {output}',
      chartNoData: '—'
    }

    /* ------------------------------------------------------------------ *
     * Number formatting (ports of ui-chat/src/client/chat/token-format.ts)
     * ------------------------------------------------------------------ */

    /** Compact token count: 517 / 12.2K / 1.2M. */
    function formatTokens(value, t) {
      const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10))
      if (value < 1000) return String(value)
      if (value < 1000000) return t('thousand', { value: scaled(value / 1000) })
      return t('million', { value: scaled(value / 1000000) })
    }

    /** Exact integer token count with locale-owned digit grouping. */
    function formatExactTokens(value, t) {
      const digits = String(value)
      const groups = []
      for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end))
      return groups.join(t('groupSeparator'))
    }

    function formatTokensPerSecond(tps) {
      const clamped = Math.max(0, tps)
      return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
    }

    /** Round a cache-read ratio to exact percentage units, ties rounded up. */
    function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
      const unitsPerPercent = decimalPlaces === 0 ? 1 : 10
      const scale = unitsPerPercent * 100
      const doubledScale = scale * 2
      const denominatorQuotient = Math.floor(denominator / doubledScale)
      const denominatorRemainder = denominator % doubledScale
      let lower = 0
      let upper = scale
      while (lower < upper) {
        const candidate = Math.floor((lower + upper + 1) / 2)
        const factor = candidate * 2 - 1
        const threshold = factor * denominatorQuotient + Math.ceil((factor * denominatorRemainder) / doubledScale)
        if (cacheReadTokens >= threshold) lower = candidate
        else upper = candidate - 1
      }
      return lower
    }

    function displayPercentUnits(units, decimalPlaces) {
      if (decimalPlaces === 0) return String(units)
      const whole = Math.floor(units / 10)
      const tenths = units % 10
      return tenths === 0 ? String(whole) : `${whole}.${tenths}`
    }

    /**
     * Display-ready cache-hit share that never rounds a partial hit to 100%.
     * @returns percentage text, or null when there was no prompt input.
     */
    function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
      if (promptTokens === 0) return null
      const missedInputTokens = promptTokens - cacheReadTokens
      // `<= 0` (not `=== 0`): a host that reports an oversized cache-read bucket
      // must not walk the precision loop below with a negative gap — it never
      // terminates and the final '9'.repeat() would throw on the render thread.
      if (missedInputTokens <= 0) return '100'
      const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
      const fullHitUnits = decimalPlaces === 0 ? 100 : 1000
      if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces)
      let distinguishingPlaces = 1
      let scaledDoubleGap = missedInputTokens * 200
      const denominatorTens = Math.floor(promptTokens / 10)
      while (scaledDoubleGap <= denominatorTens) {
        scaledDoubleGap *= 10
        distinguishingPlaces += 1
      }
      const denominatorOnes = promptTokens % 10
      let roundedLoss = 5
      for (let loss = 1; loss < 5; loss += 1) {
        const factor = loss * 2 + 1
        const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10)
        if (scaledDoubleGap <= threshold) {
          roundedLoss = loss
          break
        }
      }
      return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`
    }

    /** Compact duration: 45.2s under a minute, 2m42s from there on. */
    function formatDuration(ms, t) {
      const seconds = ms / 1000
      if (seconds < 60) return t('compactSeconds', { seconds: Math.round(seconds * 10) / 10 })
      const whole = Math.round(seconds)
      return t('compactMinutes', { minutes: Math.floor(whole / 60), seconds: whole % 60 })
    }

    /* ------------------------------------------------------------------ *
     * Cumulative accounting helpers
     * ------------------------------------------------------------------ */

    const EMPTY_STATS = Object.freeze({
      turns: 0,
      steps: 0,
      llmMs: 0,
      toolMs: 0,
      ttftMs: 0,
      ttftSteps: 0,
      decodeMs: 0,
      decodeTokens: 0
    })

    /** Sum the three disjoint prompt-side billing buckets. */
    function billedInput(usage) {
      return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    }

    /** Every prompt-side billing bucket plus output. */
    function totalTokens(usage) {
      return billedInput(usage) + usage.outputTokens
    }

    /**
     * Fallback used only when the `sessionStats` projection is missing from the
     * assembly: counts and wall times from the window's chat nodes. TTFT and
     * decode figures stay zero because their per-step derivation is ui-chat
     * private; without them the speed reading is simply omitted.
     */
    function deriveWindowStats(nodes) {
      if (!Array.isArray(nodes)) return EMPTY_STATS
      const turns = new Set()
      let steps = 0
      let llmMs = 0
      let toolMs = 0
      for (const node of nodes) {
        if (node === null || typeof node !== 'object') continue
        if (node.kind === 'tool-result') {
          if (typeof node.callTime === 'number' && typeof node.time === 'number') toolMs += Math.max(0, node.time - node.callTime)
          continue
        }
        if (node.kind !== 'assistant') continue
        turns.add(node.turn)
        steps += 1
        const timing = node.timing
        if (timing && typeof timing.stepStartTime === 'number' && typeof timing.completedTime === 'number') {
          llmMs += Math.max(0, timing.completedTime - timing.stepStartTime)
        }
      }
      return { turns: turns.size, steps, llmMs, toolMs, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
    }

    /* ------------------------------------------------------------------ *
     * Sample series: one cumulative snapshot per observation
     * ------------------------------------------------------------------ */

    function emptySeries() {
      return { origin: null, samples: [] }
    }

    /** Freeze the two cumulative projections into one observation. */
    function sampleFrom(usage, stats, time) {
      return {
        t: time,
        u: [usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens],
        s: [stats.decodeMs, stats.decodeTokens]
      }
    }

    function regressed(previous, next) {
      for (let i = 0; i < previous.u.length; i += 1) if (next.u[i] < previous.u[i]) return true
      for (let i = 0; i < previous.s.length; i += 1) if (next.s[i] < previous.s[i]) return true
      return false
    }

    /**
     * Append one cumulative observation.
     * @returns a new series, or the same reference when nothing was appended.
     */
    function appendSample(series, next) {
      const samples = series.samples
      if (samples.length === 0) return { origin: next, samples: [next] }
      const last = samples[samples.length - 1]
      if (next.t - last.t < COALESCE_MS) {
        const replaced = samples.slice()
        replaced[replaced.length - 1] = next
        return { origin: series.origin, samples: replaced }
      }
      // A rewritten durable log (rewind / retry / branch) moves counters
      // backwards: the whole series restarts so no negative delta is drawn.
      if (regressed(last, next)) return { origin: next, samples: [next] }
      const appended = samples.concat([next])
      return {
        origin: series.origin,
        samples: appended.length > MAX_SAMPLES ? appended.slice(appended.length - MAX_SAMPLES) : appended
      }
    }

    /**
     * Window base for a point: the last retained sample at or before
     * `samples[index].t - windowMs`, else the session origin.
     */
    function windowBase(series, index, windowMs) {
      const samples = series.samples
      const target = samples[index].t - windowMs
      let low = 0
      let high = index
      let found = -1
      while (low <= high) {
        const mid = (low + high) >> 1
        if (samples[mid].t <= target) {
          found = mid
          low = mid + 1
        } else high = mid - 1
      }
      if (found >= 0) return samples[found]
      if (series.origin !== null && series.origin.t <= samples[index].t) return series.origin
      return samples[0]
    }

    /**
     * Points of pooled deltas. Ratios are pooled (sum over sum, token
     * weighted); the token total is differentiated over the pooled span.
     */
    function deriveWindowPoints(series, windowMs) {
      const samples = series.samples
      const points = []
      for (let index = 1; index < samples.length; index += 1) {
        const current = samples[index]
        const base = windowBase(series, index, windowMs)
        const spanMs = current.t - base.t
        if (spanMs <= 0) continue
        const du = [0, 1, 2, 3].map((slot) => current.u[slot] - base.u[slot])
        const promptDelta = du[0] + du[1] + du[2]
        const tokenDelta = promptDelta + du[3]
        const promptTotal = current.u[0] + current.u[1] + current.u[2]
        const decodeMs = current.s[0] - base.s[0]
        const decodeTokens = current.s[1] - base.s[1]
        points.push({
          t: current.t,
          spanMs,
          full: spanMs < windowMs,
          deltaTokens: tokenDelta,
          hit: promptDelta > 0 ? (du[1] / promptDelta) * 100 : null,
          cumulativeHit: promptTotal > 0 ? (current.u[1] / promptTotal) * 100 : null,
          tokenRate: (tokenDelta / spanMs) * 1000,
          // Composition rates: each counter differentiated over the pooled span.
          inputRate: (du[0] / spanMs) * 1000,
          cacheRate: (du[1] / spanMs) * 1000,
          outputRate: (du[3] / spanMs) * 1000,
          speed: decodeMs > 0 ? (decodeTokens / decodeMs) * 1000 : null,
          // Raw pooled deltas: downsampling re-pools from these so a bucket can
          // never degrade into an unweighted mean of ratios (see downsample).
          d: du,
          ds: [decodeMs, decodeTokens]
        })
      }
      return points
    }

    /**
     * Decode rate right now: Δdecode-tokens / Δdecode-ms pooled over the trailing
     * `windowMs` of samples.
     *
     * Pooled, not averaged: both sides are sums over the window, so one huge
     * sample cannot be outvoted by many tiny ones. When the window contains no
     * decoding at all (a step still streaming its first tokens, a tool call, an
     * idle turn), the most recent step pair that did decode is held so the pill
     * keeps reporting the last measured rate instead of blanking between steps.
     *
     * @param series - cumulative sample series.
     * @param windowMs - trailing window in ms.
     * @returns tokens per second, or null before any step has decoded.
     */
    function liveSpeed(series, windowMs) {
      const samples = series.samples
      if (samples.length === 0) return null
      const index = samples.length - 1
      const current = samples[index]
      const base = windowBase(series, index, windowMs)
      const spanMs = current.s[0] - base.s[0]
      if (spanMs > 0) return ((current.s[1] - base.s[1]) / spanMs) * 1000
      for (let cursor = index; cursor > 0; cursor -= 1) {
        const stepMs = samples[cursor].s[0] - samples[cursor - 1].s[0]
        if (stepMs <= 0) continue
        return ((samples[cursor].s[1] - samples[cursor - 1].s[1]) / stepMs) * 1000
      }
      return null
    }

    /**
     * Bucket-pool down to `max` points, keeping null gaps as nulls.
     *
     * A bucket is NOT an arithmetic mean of its points: ratios stay pooled
     * (ΣcacheRead / Σprompt), rates stay span-weighted (Σdelta / Σspan, which is
     * exactly the span-weighted mean of the per-point rates), and the
     * session-cumulative share — a level, not a delta — takes the bucket's last
     * value. Averaging per-point ratios here would quietly hand the hit-rate
     * line back to the tiniest requests, which is the one thing this file's
     * contract forbids.
     */
    function downsample(points, max) {
      if (points.length <= max) return points
      const pooled = []
      for (let bucket = 0; bucket < max; bucket += 1) {
        const start = Math.floor((bucket * points.length) / max)
        const stop = Math.max(start + 1, Math.floor(((bucket + 1) * points.length) / max))
        const slice = points.slice(start, stop)
        const last = slice[slice.length - 1]
        const sumOf = (pick) => slice.reduce((total, entry) => total + pick(entry), 0)
        const d = [0, 1, 2, 3].map((slot) => sumOf((entry) => entry.d[slot]))
        const spanMs = sumOf((entry) => entry.spanMs)
        const decodeMs = sumOf((entry) => entry.ds[0])
        const decodeTokens = sumOf((entry) => entry.ds[1])
        const promptDelta = d[0] + d[1] + d[2]
        const tokenDelta = promptDelta + d[3]
        pooled.push({
          t: last.t,
          spanMs,
          full: last.full,
          deltaTokens: tokenDelta,
          hit: promptDelta > 0 ? (d[1] / promptDelta) * 100 : null,
          cumulativeHit: last.cumulativeHit,
          tokenRate: spanMs > 0 ? (tokenDelta / spanMs) * 1000 : null,
          inputRate: spanMs > 0 ? (d[0] / spanMs) * 1000 : null,
          cacheRate: spanMs > 0 ? (d[1] / spanMs) * 1000 : null,
          outputRate: spanMs > 0 ? (d[3] / spanMs) * 1000 : null,
          speed: decodeMs > 0 ? (decodeTokens / decodeMs) * 1000 : null,
          d,
          ds: [decodeMs, decodeTokens]
        })
      }
      return pooled
    }

    /* ------------------------------------------------------------------ *
     * Chart model (pure: everything the SVG renderer needs)
     * ------------------------------------------------------------------ */

    function niceCeil(value) {
      if (!Number.isFinite(value) || value <= 0) return 1
      const magnitude = 10 ** Math.floor(Math.log10(value))
      const normalized = value / magnitude
      const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
      return step * magnitude
    }

    function round1(value) {
      return Math.round(value * 10) / 10
    }

    function axisNumber(value) {
      if (!Number.isFinite(value)) return '0'
      if (Math.abs(value) >= 1000000) return `${round1(value / 1000000)}M`
      if (Math.abs(value) >= 1000) return `${round1(value / 1000)}K`
      return String(Math.round(value))
    }

    /** Round a rough step up to 1 / 2 / 2.5 / 5 / 10 × 10^n. */
    function niceStep(rough) {
      if (!Number.isFinite(rough) || rough <= 0) return 1
      const magnitude = 10 ** Math.floor(Math.log10(rough))
      const normalized = rough / magnitude
      const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
      return factor * magnitude
    }

    /** Percent value text with at most one decimal, trailing .0 trimmed. */
    function percentText(value) {
      const rounded = Math.round(value * 10) / 10
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
    }

    /**
     * The y window for one chart, chosen per quantity because their natural
     * ranges differ:
     *
     *   - RATIOS live against a ceiling — a healthy cache-hit share is 90–100%,
     *     so a 0–100 axis squashes it into a flat line at the top. The band is
     *     fitted to the data (floor span 2pp, snapped outward to a nice step,
     *     clamped to [0,100]).
     *   - RATES keep their zero baseline while they actually reach for it:
     *     idle gaps falling to 0 tok/s are information. Once a window stays well
     *     above zero (min > 30% of the peak) the band is fitted too, because a
     *     steady 40–55 tok/s stream is otherwise a flat line as well.
     *
     * A fitted band is never silent: the caller prints the range in the footer.
     */
    function fitAxis(values, options) {
      const percent = options !== undefined && options.mode === 'percent'
      const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
      if (finite.length === 0) return percent ? { y0: 0, y1: 100 } : { y0: 0, y1: 1 }
      let min = Math.min(...finite)
      let max = Math.max(...finite)
      if (percent) {
        min = Math.max(0, Math.min(100, min))
        max = Math.max(0, Math.min(100, max))
      }
      const fits = percent || (max > 0 && min > 0.3 * max)
      if (!fits) return { y0: 0, y1: niceCeil(Math.max(1, max) * 1.15) }
      const spread = Math.max(0, max - min)
      const span = Math.max(spread, percent ? 2 : max * 0.04)
      const step = niceStep(span / 2)
      let lo = Math.floor((min - span * 0.2) / step) * step
      let hi = Math.ceil((max + span * 0.2) / step) * step
      if (percent) {
        if (hi > 100) hi = 100
        if (lo < 0) lo = 0
        if (hi - lo < 1) lo = Math.max(0, hi - 1)
      } else if (hi - lo < step) {
        hi = lo + step
      }
      return { y0: lo, y1: hi }
    }

    function windowLabel(windowId) {
      if (windowId === 'session') return 'windowSession'
      if (windowId === '30s') return 'window30s'
      if (windowId === '5m') return 'window5m'
      return 'window1m'
    }

    function windowMsOf(windowId) {
      const preset = WINDOWS.find((entry) => entry.id === windowId)
      return preset === undefined ? 60000 : preset.ms
    }

    /** Inverse of {@link windowMsOf}: which preset produced this window. */
    function windowIdOf(windowMs) {
      if (windowMs === Infinity) return 'session'
      const preset = WINDOWS.find((entry) => entry.ms === windowMs)
      return preset === undefined ? DEFAULT_WINDOW_ID : preset.id
    }

    function segmentsFor(points, values, project) {
      const segments = []
      let current = []
      points.forEach((point, index) => {
        const value = values[index]
        if (value === null || value === undefined || !Number.isFinite(value)) {
          if (current.length > 0) segments.push(current)
          current = []
          return
        }
        current.push(project(point.t, value))
      })
      if (current.length > 0) segments.push(current)
      // A polyline needs two points; isolated samples contribute their dot only.
      return segments.map((segment) => segment.join(' ')).filter((segment) => segment.includes(' '))
    }

    /** Peak of the finite values of one series (0 when it has none). */
    function peakOf(values) {
      let peak = 0
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value) && value > peak) peak = value
      }
      return peak
    }

    /**
     * Everything the chart needs for one tab.
     *
     * Lines whose peak is far below their neighbour's (a 1:4 split or worse) move
     * to a SECOND y axis on the right: with a 100x gap — consumption rate in the
     * thousands against output speed in the dozens — a shared axis pins the
     * small line to the bottom edge and hides exactly the variation the chart
     * exists to show. Each axis is fitted independently (see fitAxis), and each
     * axis label is drawn in its own line's colour so the sides stay readable.
     *
     * @param series - cumulative sample series.
     * @param windowMs - rolling window in ms (`Infinity` pools the session).
     * @param tab - 'hit' (pooled ratios), 'rate' (pooled rates) or 'split'
     *   (input / cache / output counters each differentiated over the span).
     * @param t - locale seat.
     */
    function buildChartModel(series, windowMs, tab, t) {
      const points = downsample(deriveWindowPoints(series, windowMs), MAX_POINTS)
      // The label must name the preset that actually pooled the data, not a
      // hard-coded default: 30s/5m used to be announced as "1m".
      const windowText = t(windowLabel(windowIdOf(windowMs)))
      const usesPercentAxis = tab === 'hit'
      const plotHeight = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM
      const lines =
        tab === 'rate'
          ? [
              { key: 'rate', color: COLOR_BRAND, width: 1.5, values: points.map((point) => point.tokenRate) },
              { key: 'speed', color: COLOR_SECONDARY, width: 1.25, values: points.map((point) => point.speed) }
            ]
          : tab === 'split'
            ? [
                { key: 'cache', color: COLOR_SUCCESS, width: 1.5, values: points.map((point) => point.cacheRate) },
                { key: 'input', color: COLOR_SECONDARY, width: 1.25, values: points.map((point) => point.inputRate) },
                { key: 'output', color: COLOR_WARN, width: 1.25, values: points.map((point) => point.outputRate) }
              ]
            : [
                { key: 'hit', color: COLOR_BRAND, width: 1.5, values: points.map((point) => point.hit) },
                { key: 'cumulative', color: COLOR_MUTED, width: 1.1, dash: '3 3', values: points.map((point) => point.cumulativeHit) }
              ]
      // Ratios share one 0–100 scale by nature, so only rate charts can split.
      const peaks = lines.map((line) => peakOf(line.values))
      const topPeak = peaks.reduce((peak, value) => Math.max(peak, value), 0)
      let leftLines = lines
      let rightLines = []
      if (!usesPercentAxis && topPeak > 0) {
        const left = []
        const right = []
        lines.forEach((line, index) => {
          if (peaks[index] >= topPeak / AXIS_SPLIT_RATIO) left.push(line)
          else right.push(line)
        })
        if (left.length > 0 && right.length > 0) {
          leftLines = left
          rightLines = right
        }
      }
      const dual = rightLines.length > 0
      const padRight = dual ? CHART_PAD_RIGHT_DUAL : CHART_PAD_RIGHT
      const plotWidth = CHART_WIDTH - CHART_PAD_LEFT - padRight
      const bandOf = (values) => fitAxis(values, { mode: usesPercentAxis ? 'percent' : 'rate' })
      const leftAxis = bandOf(leftLines.flatMap((line) => line.values))
      const rightAxis = dual ? bandOf(rightLines.flatMap((line) => line.values)) : null
      const bandFor = (side) => (side === 'right' && rightAxis !== null ? rightAxis : leftAxis)
      const yText = (value) => (usesPercentAxis ? `${percentText(value)}%` : axisNumber(value))
      const first = points.length > 0 ? points[0].t : 0
      const last = points.length > 0 ? points[points.length - 1].t : 0
      const x0 = first
      const x1 = last > first ? last : first + 1
      const toX = (time) => CHART_PAD_LEFT + ((time - x0) / (x1 - x0 || 1)) * plotWidth
      const toY = (side, value) => {
        const band = bandFor(side)
        return CHART_PAD_TOP + plotHeight - ((value - band.y0) / (band.y1 - band.y0 || 1)) * plotHeight
      }
      const project = (side) => (time, value) => `${round1(toX(time))},${round1(toY(side, value))}`
      const seriesList = lines.map((line) => {
        const side = rightLines.includes(line) ? 'right' : 'left'
        return {
          key: line.key,
          color: line.color,
          width: line.width,
          dash: line.dash,
          side,
          segments: segmentsFor(points, line.values, project(side))
        }
      })
      const axisLabels = (axis, side, color) => [1, 0.5, 0].map((fraction) => {
        const value = axis.y0 + (axis.y1 - axis.y0) * fraction
        return { y: round1(toY(side, value)), text: yText(value), color }
      })
      const leftLabels = axisLabels(leftAxis, 'left', dual ? leftLines[0].color : null)
      const rightLabels = rightAxis === null ? null : axisLabels(rightAxis, 'right', rightLines[0].color)
      const y0 = leftAxis.y0
      const y1 = leftAxis.y1
      const zoomed = y0 > 0 || dual
      const lastIndex = points.length - 1
      const lastPoint = lastIndex >= 0 ? points[lastIndex] : null
      const primaryLast = lastIndex >= 0 ? lines[0].values[lastIndex] : null
      const lastDot =
        lastPoint !== null && typeof primaryLast === 'number' && Number.isFinite(primaryLast)
          ? { t: lastPoint.t, v: primaryLast, color: lines[0].color, side: seriesList[0].side }
          : null
      const cumulativeText = lastPoint !== null && lastPoint.cumulativeHit !== null ? String(Math.round(lastPoint.cumulativeHit)) : t('chartNoData')
      const rateText = lastPoint !== null ? formatTokensPerSecond(lastPoint.tokenRate) : t('chartNoData')
      const speedText = lastPoint !== null && lastPoint.speed !== null ? formatTokensPerSecond(lastPoint.speed) : t('chartNoData')
      const hitText = lastPoint !== null && lastPoint.hit !== null ? String(Math.round(lastPoint.hit)) : t('chartNoData')
      const inputText = lastPoint !== null ? formatTokensPerSecond(lastPoint.inputRate) : t('chartNoData')
      const cacheText = lastPoint !== null ? formatTokensPerSecond(lastPoint.cacheRate) : t('chartNoData')
      const outputText = lastPoint !== null ? formatTokensPerSecond(lastPoint.outputRate) : t('chartNoData')
      const summary =
        points.length < 2
          ? t('chartStarved', { count: points.length })
          : tab === 'rate'
            ? t('chartSummaryRate', { window: windowText, rate: rateText, speed: speedText })
            : tab === 'split'
              ? t('chartSummarySplit', { window: windowText, input: inputText, cache: cacheText, output: outputText })
              : t('chartSummaryHit', { window: windowText, hit: hitText, cumulative: cumulativeText })
      // The footer always states the scale: a zoomed band, or which side carries
      // which range when the chart split.
      const axisNote = usesPercentAxis
        ? y0 > 0
          ? t('chartFootAxisPercent', { min: percentText(y0), max: percentText(y1) })
          : null
        : dual
          ? t('chartFootAxisDual', {
              left: `${axisNumber(leftAxis.y0)}–${axisNumber(leftAxis.y1)}`,
              right: `${axisNumber(rightAxis.y0)}–${axisNumber(rightAxis.y1)}`
            })
          : y0 > 0
            ? t('chartFootAxisRate', { min: axisNumber(y0), max: axisNumber(y1) })
            : null
      const baseFoot =
        tab === 'hit'
          ? t('chartFootHit', { window: windowText, cumulative: cumulativeText })
          : t('chartFootRate', {
              window: windowText,
              delta: lastPoint !== null ? axisNumber(lastPoint.deltaTokens) : '0',
              seconds: lastPoint !== null ? String(Math.round(lastPoint.spanMs / 1000)) : '0'
            })
      return {
        points,
        series: seriesList,
        dual,
        y0,
        y1,
        zoomed,
        toX,
        toY,
        lastDot,
        summary,
        foot: axisNote === null ? baseFoot : `${baseFoot} · ${axisNote}`,
        leftLabels,
        rightLabels,
        padRight,
        yTopLabel: yText(y1),
        yMidLabel: yText((y0 + y1) / 2),
        yBottomLabel: yText(y0),
        xStartLabel: lastPoint !== null && lastPoint.full ? t('axisSince') : `-${windowText}`,
        xEndLabel: t('axisNow'),
        empty: points.length < 2
      }
    }

    /* ------------------------------------------------------------------ *
     * Persistence: the curve survives a page refresh
     * ------------------------------------------------------------------ */

    const seriesCache = new Map()
    const persistTimers = new Map()

    function storageGet(key) {
      try {
        return window.sessionStorage.getItem(key)
      } catch (error) {
        return null
      }
    }

    function storageSet(key, value) {
      try {
        window.sessionStorage.setItem(key, value)
      } catch (error) {
        /* Private mode / quota: the curve simply stays in memory. */
      }
    }

    function isValidSample(sample) {
      return (
        sample !== null &&
        typeof sample === 'object' &&
        typeof sample.t === 'number' &&
        Array.isArray(sample.u) &&
        sample.u.length === 4 &&
        sample.u.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0) &&
        Array.isArray(sample.s) &&
        sample.s.length === 2 &&
        sample.s.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      )
    }

    function readWindowPreference() {
      const stored = storageGet(WINDOW_KEY)
      return WINDOWS.some((entry) => entry.id === stored) ? stored : DEFAULT_WINDOW_ID
    }

    function rememberWindowPreference(windowId) {
      storageSet(WINDOW_KEY, windowId)
    }

    function restoreSeries(sessionId) {
      const raw = storageGet(`${PERSIST_PREFIX}${sessionId}`)
      if (raw === null) return emptySeries()
      try {
        const parsed = JSON.parse(raw)
        const samples = parsed !== null && Array.isArray(parsed.samples) ? parsed.samples.filter(isValidSample) : []
        const origin = parsed !== null && isValidSample(parsed.origin) ? parsed.origin : null
        if (samples.length === 0) return emptySeries()
        return { origin: origin === null ? samples[0] : origin, samples }
      } catch (error) {
        return emptySeries()
      }
    }

    function seriesFor(sessionId) {
      const key = String(sessionId)
      const cached = seriesCache.get(key)
      if (cached !== undefined) {
        // Touch: Map order is the recency order, so the session on screen keeps
        // its slot while background sessions age out first (LRU, not FIFO).
        seriesCache.delete(key)
        seriesCache.set(key, cached)
        return cached
      }
      const restored = restoreSeries(key)
      seriesCache.set(key, restored)
      evictSeriesOverflow()
      return restored
    }

    /** Write a session's pending snapshot now, cancelling its throttle timer. */
    function flushSeries(key) {
      const timer = persistTimers.get(key)
      if (timer === undefined) return
      clearTimeout(timer)
      persistTimers.delete(key)
      const current = seriesCache.get(key)
      if (current === undefined) return
      storageSet(`${PERSIST_PREFIX}${key}`, JSON.stringify({ origin: current.origin, samples: current.samples.slice(-PERSIST_SAMPLES) }))
    }

    /** Drop the least recently used session, flushing its pending write first. */
    function evictSeriesOverflow() {
      while (seriesCache.size > MAX_SESSIONS) {
        const oldest = seriesCache.keys().next().value
        if (oldest === undefined) return
        flushSeries(oldest)
        seriesCache.delete(oldest)
      }
    }

    /** Per-session listeners: the sampler lives in the stats cell, the token
     * chip only reads, so a sample append must wake every reader. */
    const seriesListeners = new Map()

    function subscribeSeries(sessionId, listener) {
      const key = String(sessionId)
      const listeners = seriesListeners.get(key) || new Set()
      listeners.add(listener)
      seriesListeners.set(key, listeners)
      return function unsubscribe() {
        listeners.delete(listener)
        if (listeners.size === 0) seriesListeners.delete(key)
      }
    }

    function notifySeries(sessionId) {
      const listeners = seriesListeners.get(String(sessionId))
      if (listeners === undefined) return
      for (const listener of Array.from(listeners)) listener()
    }

    function rememberSeries(sessionId, series) {
      const key = String(sessionId)
      seriesCache.set(key, series)
      evictSeriesOverflow()
      notifySeries(key)
      if (persistTimers.has(key)) return
      persistTimers.set(
        key,
        setTimeout(() => {
          flushSeries(key)
        }, PERSIST_THROTTLE_MS)
      )
    }

    /* ------------------------------------------------------------------ *
     * Sampling — one shared writer, so a second seat can stand in
     * ------------------------------------------------------------------ */

    /**
     * Append one observation for a session and wake every reader.
     * @returns the new series, or null when nothing was appended.
     */
    function pushSample(sessionId, usage, stats, now) {
      if (usage === undefined || usage === null || stats === undefined || stats === null) return null
      const previous = seriesFor(sessionId)
      const next = appendSample(previous, sampleFrom(usage, stats, now === undefined ? Date.now() : now))
      if (next === previous) return null
      rememberSeries(sessionId, next)
      return next
    }

    /** Age of the newest sample, or Infinity when the session has none yet. */
    function seriesAgeMs(sessionId, now) {
      const samples = seriesFor(sessionId).samples
      if (samples.length === 0) return Infinity
      return (now === undefined ? Date.now() : now) - samples[samples.length - 1].t
    }

    /* ------------------------------------------------------------------ *
     * Styles (one tag, owned by apply's effect)
     * ------------------------------------------------------------------ */

    const STYLE_MARK = `${NS}/pills`
    const STYLES = `
.dss-root{display:flex;justify-content:center;gap:12px;min-width:0;max-width:100%;box-sizing:border-box}
.dss-anchor{position:relative;display:inline-flex;min-width:0;box-sizing:border-box}
/* The chip is its own dock cell, so it has to carry the same type metrics the
   pill row sets for itself — without this it renders one size larger than the
   pills it sits beside. Applying the pair to both classes is idempotent inside
   the row (nested anchors simply inherit identical values). */
.dss-root,.dss-anchor{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.dss-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;border:none;border-radius:999px;corner-shape:round;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap}
.dss-pill svg{width:14px;height:14px;flex:none}
button.dss-pill{cursor:pointer}
button.dss-pill:hover,button.dss-pill[aria-expanded='true']{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dss-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dss-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}
.dss-panel{position:fixed;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,calc(100vw - 24px));max-width:min(440px,calc(100vw - 24px));padding:16px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:default}
.dss-title{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}
.dss-titleRule{margin-bottom:10px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.dss-titleValue{font-variant-numeric:tabular-nums}
.dss-titleLabel{display:inline-flex;align-items:center;gap:6px;min-width:0}
.dss-titleLabel svg{width:14px;height:14px;flex:none}
.dss-details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary)}
.dss-details dt,.dss-details dd{min-width:0;margin:0}
.dss-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
.dss-chart{margin-top:10px;padding-top:8px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.dss-chartHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}
.dss-segmented{display:inline-flex;gap:2px;padding:1px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover)}
.dss-segment{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:16px;padding:0 6px;border-radius:5px;cursor:pointer;white-space:nowrap}
.dss-segment[aria-selected='true'],.dss-segment[aria-pressed='true']{background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary)}
.dss-chartBox{display:block}
.dss-grid{stroke:var(--dsw-alias-border-l2);stroke-width:1}
.dss-axis{font-size:9px;fill:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dss-starved{color:var(--dsw-alias-label-tertiary);padding:20px 0;text-align:center}
.dss-foot{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dss-legend{display:flex;gap:10px;margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dss-legendItem{display:inline-flex;align-items:center;gap:4px}
.dss-legendLine{width:10px;height:2px;border-radius:1px;display:inline-block}
.dss-legendDash{width:10px;border-top:1.5px dashed currentColor;display:inline-block}
@media (width<=480px){.dss-label{display:none}}
`.trim()

    function injectStyles() {
      if (!HAS_DOCUMENT) return function noop() {}
      if (typeof document.querySelector === 'function' && document.querySelector(`style[data-plugin-css="${STYLE_MARK}"]`) !== null) {
        return function noop() {}
      }
      const tag = document.createElement('style')
      if (tag.dataset !== undefined && tag.dataset !== null) {
        tag.dataset.plugin = NS
        tag.dataset.pluginCss = STYLE_MARK
      }
      tag.textContent = STYLES
      document.head.appendChild(tag)
      return function removeStyles() {
        if (tag.parentNode && typeof tag.parentNode.removeChild === 'function') tag.parentNode.removeChild(tag)
      }
    }

    /* ------------------------------------------------------------------ *
     * Dialog seat (mirrors ui-chat's stat-dialog.ts)
     * ------------------------------------------------------------------ */

    /** One-shot diagnostic latch for an unplaceable dialog (see useStatDialog). */
    let anchorWarningIssued = false

    /**
     * Fallback placement for when the host's anchored-position primitive is
     * missing or declines to place the panel. The panel is position:fixed, so we
     * can measure the anchor and clamp it into the viewport ourselves — two
     * passes, because the first render has not sized the panel yet. Without this
     * the dialog fell back to inline placement inside the composer dock, whose
     * clipping box left only a quarter of the panel visible.
     */
    function useOwnAnchoredPosition(seed) {
      const [pos, setPos] = React.useState(null)
      React.useEffect(() => {
        if (!seed.open || !HAS_DOCUMENT || typeof window === 'undefined') {
          setPos(null)
          return undefined
        }
        let frame = null
        const place = () => {
          const anchor = seed.anchorRef.current
          if (anchor === null || anchor === undefined || typeof anchor.getBoundingClientRect !== 'function') return
          const rect = anchor.getBoundingClientRect()
          const panel = seed.panelRef.current
          const width = panel !== null && panel !== undefined && panel.offsetWidth > 0 ? panel.offsetWidth : 300
          const height = panel !== null && panel !== undefined && panel.offsetHeight > 0 ? panel.offsetHeight : 180
          const viewportWidth = window.innerWidth || 0
          const viewportHeight = window.innerHeight || 0
          let left = rect.left
          let top = rect.top - height - PANEL_GAP
          if (top < PANEL_MARGIN) top = rect.bottom + PANEL_GAP
          if (viewportWidth > 0) left = Math.min(left, viewportWidth - width - PANEL_MARGIN)
          if (viewportHeight > 0) top = Math.min(top, viewportHeight - height - PANEL_MARGIN)
          left = Math.max(PANEL_MARGIN, left)
          top = Math.max(PANEL_MARGIN, top)
          setPos({ left: `${Math.round(left)}px`, top: `${Math.round(top)}px` })
        }
        place()
        if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(place)
        if (typeof window.addEventListener === 'function') window.addEventListener('resize', place)
        return () => {
          if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          if (typeof window.removeEventListener === 'function') window.removeEventListener('resize', place)
        }
      }, [seed.open, seed.anchorRef, seed.panelRef])
      return pos
    }

    function useStatDialog(controlled) {
      const [ownOpen, setOwnOpen] = React.useState(false)
      const open = controlled !== undefined ? controlled.open : ownOpen
      const setOpen = controlled !== undefined ? controlled.setOpen : setOwnOpen
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const hostPos = useAnchoredPosition({
        open,
        anchorRef: rootRef,
        panelRef,
        side: 'top',
        gap: PANEL_GAP,
        margin: PANEL_MARGIN
      })
      const ownPos = useOwnAnchoredPosition({ open, anchorRef: rootRef, panelRef })
      const pos = hostPos !== null && hostPos !== undefined ? hostPos : ownPos
      useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
      React.useEffect(() => {
        if (!open || !HAS_DOCUMENT || typeof document.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open, setOpen])
      // A panel that never receives a placement would stay `visibility:hidden`
      // and a click would look like a no-op. Say so once, with the likely cause.
      React.useEffect(() => {
        if (!open || !HAS_ANCHOR_API || pos !== null && pos !== undefined) return undefined
        const timer = setTimeout(() => {
          if (!anchorWarningIssued) {
            anchorWarningIssued = true
            console.warn(`${NS}: the anchored-position primitive returned no placement; the stat dialog may be invisible. Check the host primitive's option names.`)
          }
        }, 500)
        return () => clearTimeout(timer)
      }, [open, pos])
      return { open, setOpen, rootRef, panelRef, pos }
    }

    /** One portaled (or, degraded, inline) dialog surface. */
    function dialogElement(seat, spec) {
      const style = PORTAL ? (seat.pos == null ? MEASURE_STYLE : seat.pos) : INLINE_PANEL_STYLE
      const body = h(
        'div',
        {
          className: 'dss-panel',
          role: 'dialog',
          'aria-label': spec.ariaLabel,
          ref: seat.panelRef,
          style,
          onPointerEnter: spec.onPointerEnter,
          onPointerLeave: spec.onPointerLeave
        },
        spec.titleNode,
        h('div', { className: 'dss-titleRule', 'aria-hidden': true }),
        h('dl', { className: 'dss-details', [spec.dataAttr]: true }, spec.rows),
        h(ChartBlock, {
          series: spec.series,
          view: spec.view,
          t: spec.t,
          onPointerEnter: spec.onPointerEnter,
          onPointerLeave: spec.onPointerLeave
        })
      )
      if (!PORTAL) return body
      return createPortal(body, document.body)
    }

    /* ------------------------------------------------------------------ *
     * Chart components
     * ------------------------------------------------------------------ */

    function renderChartSvg(model) {
      const children = []
      const plotRight = CHART_WIDTH - model.padRight
      // Grid rows come from the left band; the right band maps its own min/max
      // onto the same rows, so each side keeps its own values there.
      model.leftLabels.forEach((label, index) => {
        children.push(
          h('line', { key: `grid-${index}`, className: 'dss-grid', x1: CHART_PAD_LEFT, x2: plotRight, y1: label.y, y2: label.y })
        )
      })
      const axisText = (key, label, x, anchor) =>
        h(
          'text',
          { key, className: 'dss-axis', x, y: label.y + 3, textAnchor: anchor, style: label.color === null ? undefined : { fill: label.color } },
          label.text
        )
      model.leftLabels.forEach((label, index) => {
        children.push(axisText(`y-left-${index}`, label, CHART_PAD_LEFT - 3, 'end'))
      })
      if (model.rightLabels !== null) {
        // The second axis: same rows, its own scale, drawn in its line's colour
        // so the right-hand numbers are unmistakably the right-hand curve's.
        model.rightLabels.forEach((label, index) => {
          children.push(axisText(`y-right-${index}`, label, plotRight + 4, 'start'))
        })
      }
      children.push(
        h('text', { key: 'x-start', className: 'dss-axis', x: CHART_PAD_LEFT, y: CHART_HEIGHT - 3 }, model.xStartLabel),
        h('text', { key: 'x-end', className: 'dss-axis', x: plotRight, y: CHART_HEIGHT - 3, textAnchor: 'end' }, model.xEndLabel)
      )
      model.series.forEach((line) => {
        line.segments.forEach((segment, index) => {
          children.push(
            h('polyline', {
              key: `${line.key}-${index}`,
              points: segment,
              fill: 'none',
              stroke: line.color,
              strokeWidth: line.width,
              strokeDasharray: line.dash,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
              vectorEffect: 'non-scaling-stroke'
            })
          )
        })
      })
      if (model.lastDot !== null) {
        children.push(
          h('circle', {
            key: 'last',
            cx: round1(model.toX(model.lastDot.t)),
            cy: round1(model.toY(model.lastDot.side, model.lastDot.v)),
            r: 2.4,
            fill: model.lastDot.color
          })
        )
      }
      return h(
        'svg',
        {
          viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`,
          width: CHART_WIDTH,
          height: CHART_HEIGHT,
          role: 'img',
          'aria-label': model.summary,
          className: 'dss-chartBox'
        },
        children
      )
    }

    function legendItem(label, color, dashed, axisTag) {
      return h(
        'span',
        { className: 'dss-legendItem', key: label },
        dashed === true
          ? h('span', { className: 'dss-legendDash', style: { color } })
          : h('span', { className: 'dss-legendLine', style: { background: color } }),
        axisTag === undefined || axisTag === null ? label : `${label}${axisTag}`
      )
    }

    /**
     * The chart block appended under a dialog's detail rows.
     *
     * Each seat renders exactly ONE view — the quantity that seat is about — so
     * the metric switcher is gone: the gauge pill charts rates, the token pill
     * charts the hit share, the token chip charts the breakdown. Only the time
     * window stays switchable, because that is a different question ("how far
     * back"), not a duplicate of the other seat's chart.
     */
    function ChartBlock({ series, view, t, onPointerEnter, onPointerLeave }) {
      const [windowId, setWindowId] = React.useState(readWindowPreference)
      const windowMs = windowMsOf(windowId)
      const model = React.useMemo(() => buildChartModel(series, windowMs, view, t), [series, windowMs, view, t])
      return h(
        'div',
        { className: 'dss-chart', onPointerEnter, onPointerLeave },
        h(
          'div',
          { className: 'dss-chartHead' },
          h(
            'div',
            { className: 'dss-segmented', role: 'group', 'aria-label': t('windowGroup') },
            WINDOWS.map((preset) =>
              h(
                'button',
                {
                  key: preset.id,
                  type: 'button',
                  className: 'dss-segment',
                  'aria-label': t('windowAria', { window: t(windowLabel(preset.id)) }),
                  'aria-pressed': windowId === preset.id,
                  onClick: () => {
                    setWindowId(preset.id)
                    rememberWindowPreference(preset.id)
                  }
                },
                t(windowLabel(preset.id))
              )
            )
          )
        ),
        model.empty ? h('div', { className: 'dss-starved' }, t('chartStarved', { count: model.points.length })) : renderChartSvg(model),
        h(
          'div',
          { className: 'dss-legend' },
          // A line that moved to the right axis says so, so the two scales in the
          // plot cannot be mistaken for one.
          (view === 'rate'
            ? [
                legendItem(t('chartLegendRate'), COLOR_BRAND, false, sideTag(model, 'rate', t)),
                legendItem(t('chartLegendSpeed'), COLOR_SECONDARY, false, sideTag(model, 'speed', t))
              ]
            : view === 'split'
              ? [
                  legendItem(t('chartLegendCache'), COLOR_SUCCESS, false, sideTag(model, 'cache', t)),
                  legendItem(t('chartLegendInput'), COLOR_SECONDARY, false, sideTag(model, 'input', t)),
                  legendItem(t('chartLegendOutput'), COLOR_WARN, false, sideTag(model, 'output', t))
                ]
              : [legendItem(t('chartLegendHit'), COLOR_BRAND, false), legendItem(t('chartLegendCumulative'), COLOR_MUTED, true)])
        ),
        h('div', { className: 'dss-foot' }, model.foot)
      )
    }

    /** `（右轴）` for a line that was moved to the second axis; null otherwise. */
    function sideTag(model, key, t) {
      const line = model.series.find((entry) => entry.key === key)
      return line !== undefined && line.side === 'right' ? t('axisRightMark') : null
    }

    /* ------------------------------------------------------------------ *
     * The two pills
     * ------------------------------------------------------------------ */

    function TimePill({ stats, series, t, speed, open, setOpen, hoverOpen, hoverClose }) {
      const seat = useStatDialog({ open, setOpen })
      const interactive = stats.llmMs > 0 || stats.toolMs > 0 || stats.ttftSteps > 0 || stats.decodeMs > 0
      const counts = t('counts', { turns: stats.turns, steps: stats.steps })
      // Whole-session decode average: the figure the built-in pill shows. It is
      // kept for the dialog (it is the comparable history reading) but never
      // leads on the pill, where a live rate is what the row exists for.
      const average = stats.decodeMs > 0 ? stats.decodeTokens / (stats.decodeMs / 1000) : null
      const measured = typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : null
      const live = measured === null ? average : measured
      const tps = live === null ? null : t('tokensPerSecond', { tps: formatTokensPerSecond(live) })
      const label = h(
        'span',
        { className: 'dss-label' },
        counts,
        tps === null ? null : [h('span', { className: 'dss-sep', 'aria-hidden': true, key: 'sep' }, '·'), tps]
      )
      const trigger = interactive
        ? h(
            'button',
            {
              type: 'button',
              className: 'dss-pill',
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
              'aria-label': tps === null ? counts : `${counts} · ${tps}`,
              onClick: () => setOpen(!open),
              onPointerEnter: hoverOpen,
              onPointerLeave: hoverClose
            },
            IconGauge === null ? null : h(IconGauge, {}),
            label
          )
        : h('span', { className: 'dss-pill' }, IconGauge === null ? null : h(IconGauge, {}), label)
      const rows = []
      if (stats.llmMs > 0) rows.push(h('dt', { key: 'llm-dt' }, t('dialogLlmTime')), h('dd', { key: 'llm-dd' }, formatDuration(stats.llmMs, t)))
      if (stats.toolMs > 0) rows.push(h('dt', { key: 'tool-dt' }, t('dialogToolTime')), h('dd', { key: 'tool-dd' }, formatDuration(stats.toolMs, t)))
      if (stats.ttftSteps > 0) rows.push(h('dt', { key: 'ttft-dt' }, t('dialogTtft')), h('dd', { key: 'ttft-dd' }, formatDuration(stats.ttftMs / stats.ttftSteps, t)))
      if (live !== null) {
        rows.push(
          h('dt', { key: 'speed-dt' }, t('dialogSpeedLive', { seconds: Math.round(LIVE_WINDOW_MS / 1000) })),
          h('dd', { key: 'speed-dd' }, t('tokensPerSecond', { tps: formatTokensPerSecond(live) }))
        )
      }
      if (average !== null) {
        rows.push(
          h('dt', { key: 'avg-dt' }, t('dialogSpeedAverage')),
          h('dd', { key: 'avg-dd' }, t('tokensPerSecond', { tps: formatTokensPerSecond(average) }))
        )
      }
      return h(
        'span',
        { className: 'dss-anchor', ref: seat.rootRef },
        trigger,
        interactive && open
          ? dialogElement(seat, {
              ariaLabel: t('dialogTitle'),
              titleNode: h('div', { className: 'dss-title' }, h('span', { className: 'dss-titleLabel' }, IconGauge === null ? null : h(IconGauge, {}), t('dialogTitle'))),
              rows,
              dataAttr: 'data-session-stats-details',
              series,
              view: 'rate',              t,
              onPointerEnter: hoverOpen,
              onPointerLeave: hoverClose
            })
          : null
      )
    }

    function UsagePill({ usage, cacheHit, total, series, t, open, setOpen, hoverOpen, hoverClose }) {
      const seat = useStatDialog({ open, setOpen })
      const totalText = t('tokenCount', { count: formatTokens(total, t) })
      const label = h(
        'span',
        { className: 'dss-label' },
        totalText,
        cacheHit === null ? null : [h('span', { className: 'dss-sep', 'aria-hidden': true, key: 'sep' }, '·'), t('cacheHit', { percent: cacheHit })]
      )
      const trigger = h(
        'button',
        {
          type: 'button',
          className: 'dss-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': cacheHit === null ? totalText : `${totalText} · ${t('cacheHit', { percent: cacheHit })}`,
          onClick: () => setOpen(!open),
          onPointerEnter: hoverOpen,
          onPointerLeave: hoverClose
        },
        IconDatabase === null ? null : h(IconDatabase, {}),
        label
      )
      const rows = []
      if (cacheHit !== null) rows.push(h('dt', { key: 'hit-dt' }, t('turnUsageCacheHit')), h('dd', { key: 'hit-dd' }, t('percentValue', { percent: cacheHit })))
      rows.push(
        h('dt', { key: 'in-dt' }, t('turnUsageInput')),
        h('dd', { key: 'in-dd' }, t('tokenCount', { count: formatExactTokens(usage.uncachedInputTokens, t) })),
        h('dt', { key: 'read-dt' }, t('turnUsageCacheRead')),
        h('dd', { key: 'read-dd' }, t('tokenCount', { count: formatExactTokens(usage.cacheReadTokens, t) }))
      )
      if (usage.cacheWriteTokens !== 0) {
        rows.push(
          h('dt', { key: 'write-dt' }, t('turnUsageCacheWrite')),
          h('dd', { key: 'write-dd' }, t('tokenCount', { count: formatExactTokens(usage.cacheWriteTokens, t) }))
        )
      }
      rows.push(
        h('dt', { key: 'out-dt' }, t('turnUsageOutput')),
        h('dd', { key: 'out-dd' }, t('tokenCount', { count: formatExactTokens(usage.outputTokens, t) }))
      )
      return h(
        'span',
        { className: 'dss-anchor', ref: seat.rootRef },
        trigger,
        open
          ? dialogElement(seat, {
              ariaLabel: t('dialogUsageTitle'),
              titleNode: h(
                'div',
                { className: 'dss-title' },
                h('span', { className: 'dss-titleLabel' }, IconDatabase === null ? null : h(IconDatabase, {}), t('dialogUsageTitle')),
                h('span', { className: 'dss-titleValue' }, t('tokenCount', { count: formatExactTokens(total, t) }))
              ),
              rows,
              dataAttr: 'data-session-stats-usage',
              series,
              view: 'hit',
              t,
              onPointerEnter: hoverOpen,
              onPointerLeave: hoverClose
            })
          : null
      )
    }

    /* ------------------------------------------------------------------ *
     * Token composition chip — its own dock cell.
     *
     * It carries input / cache / output only: the row must keep exactly one
     * hit-rate reading, and that one lives on the stats pills above. The money
     * line it replaces (dsh-cost-meter's dock `position`) is turned off by
     * config, so nothing is duplicated.
     * ------------------------------------------------------------------ */

    /** Hover-open, click-pin, dismiss state for a single-pill cell. */
    function usePillOpen() {
      const [open, setOpen] = React.useState(false)
      const [pinned, setPinned] = React.useState(false)
      const openRef = React.useRef(false)
      const timer = React.useRef(null)
      openRef.current = open
      const clear = React.useCallback(() => {
        if (timer.current !== null) {
          clearTimeout(timer.current)
          timer.current = null
        }
      }, [])
      // Drop a pending hover timer when the chip leaves the dock.
      React.useEffect(() => clear, [clear])
      const hoverOpen = React.useCallback(() => {
        if (!HOVER_OPEN) return
        clear()
        timer.current = setTimeout(() => {
          timer.current = null
          setOpen(true)
        }, HOVER_OPEN_DELAY_MS)
      }, [clear])
      const hoverClose = React.useCallback(() => {
        if (!HOVER_OPEN) return
        clear()
        timer.current = setTimeout(() => {
          timer.current = null
          setPinned((currentPinned) => {
            if (!currentPinned) setOpen(false)
            return currentPinned
          })
        }, HOVER_CLOSE_DELAY_MS)
      }, [clear])
      const toggle = React.useCallback(() => {
        const next = !openRef.current
        openRef.current = next
        setPinned(next)
        setOpen(next)
      }, [])
      const close = React.useCallback(() => {
        clear()
        openRef.current = false
        setPinned(false)
        setOpen(false)
      }, [clear])
      return { open, hoverOpen, hoverClose, toggle, close }
    }

    function TokenChip(props) {
      const sessionId = props.sessionId
      const t = props.t
      const useProjection = props.useProjection
      const usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined
      const stats = typeof useProjection === 'function' ? useProjection('sessionStats') : undefined
      const [series, setSeries] = React.useState(() => seriesFor(sessionId))
      const dialog = usePillOpen()
      const seat = useStatDialog({ open: dialog.open, setOpen: () => dialog.close() })
      const latest = React.useRef({ usage, stats })
      latest.current = { usage, stats }

      React.useEffect(() => {
        setSeries(seriesFor(sessionId))
        return subscribeSeries(sessionId, () => setSeries(seriesFor(sessionId)))
      }, [sessionId])

      // Standby sampler: the stats cell is normally the writer, but another
      // plugin may win that cell (or a future host may mount this chip alone).
      // Sampling only while the shared series looks stale keeps this a backup —
      // it never doubles the primary cadence.
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (seriesAgeMs(sessionId) < SAMPLE_INTERVAL_MS * 2) return
          const next = pushSample(sessionId, latest.current.usage, latest.current.stats)
          if (next !== null) setSeries(next)
        }, SAMPLE_INTERVAL_MS)
        return () => clearInterval(timer)
      }, [sessionId])

      const billed = usage === undefined || usage === null ? 0 : billedInput(usage)
      const total = usage === undefined || usage === null ? 0 : totalTokens(usage)
      const hasTokens = usage !== undefined && usage !== null && (billed > 0 || usage.outputTokens > 0)
      if (!hasTokens) return null

      const line = t('chipLine', {
        input: formatTokens(usage.uncachedInputTokens, t),
        cache: formatTokens(usage.cacheReadTokens, t),
        output: formatTokens(usage.outputTokens, t)
      })
      const trigger = h(
        'button',
        {
          type: 'button',
          className: 'dss-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': dialog.open,
          'aria-label': t('chipSummary', {
            total: t('tokenCount', { count: formatExactTokens(total, t) }),
            input: formatExactTokens(usage.uncachedInputTokens, t),
            cache: formatExactTokens(usage.cacheReadTokens, t),
            output: formatExactTokens(usage.outputTokens, t)
          }),
          onClick: dialog.toggle,
          onPointerEnter: dialog.hoverOpen,
          onPointerLeave: dialog.hoverClose
        },
        h('span', { className: 'dss-label' }, line)
      )
      const rows = [
        h('dt', { key: 'in-dt' }, t('turnUsageInput')),
        h('dd', { key: 'in-dd' }, t('tokenCount', { count: formatExactTokens(usage.uncachedInputTokens, t) })),
        h('dt', { key: 'read-dt' }, t('turnUsageCacheRead')),
        h('dd', { key: 'read-dd' }, t('tokenCount', { count: formatExactTokens(usage.cacheReadTokens, t) }))
      ]
      if (usage.cacheWriteTokens !== 0) {
        rows.push(
          h('dt', { key: 'write-dt' }, t('turnUsageCacheWrite')),
          h('dd', { key: 'write-dd' }, t('tokenCount', { count: formatExactTokens(usage.cacheWriteTokens, t) }))
        )
      }
      rows.push(
        h('dt', { key: 'out-dt' }, t('turnUsageOutput')),
        h('dd', { key: 'out-dd' }, t('tokenCount', { count: formatExactTokens(usage.outputTokens, t) }))
      )
      return h(
        'span',
        { className: 'dss-anchor', ref: seat.rootRef },
        trigger,
        dialog.open
          ? dialogElement(seat, {
              ariaLabel: t('chipTitle'),
              titleNode: h(
                'div',
                { className: 'dss-title' },
                h('span', { className: 'dss-titleLabel' }, t('chipTitle')),
                h('span', { className: 'dss-titleValue' }, t('tokenCount', { count: formatExactTokens(total, t) }))
              ),
              rows,
              dataAttr: 'data-session-stats-split',
              series,
              view: 'split',
              t,
              onPointerEnter: dialog.hoverOpen,
              onPointerLeave: dialog.hoverClose
            })
          : null
      )
    }

    /* ------------------------------------------------------------------ *
     * The stats row (shadows the built-in cell)
     * ------------------------------------------------------------------ */

    /**
     * Renders nothing. It exists only to claim (shadow) another plugin's cell —
     * claiming is the official mechanism, so no other plugin is edited, no DOM
     * is read, and disabling this plugin restores the claimed cell untouched.
     */
    function EmptyCell() {
      return null
    }

    function StatsRow(props) {
      const sessionId = props.sessionId
      const t = props.t
      const props_useProjection = props.useProjection
      const useChat = props.useChat

      // Every hook runs before the early return below.
      const projected = typeof props_useProjection === 'function' ? props_useProjection('sessionStats') : undefined
      const usage = typeof props_useProjection === 'function' ? props_useProjection('tokenUsage') : undefined
      // The snapshot shape is the host's; a nullish or differently-shaped chat
      // snapshot must degrade to "no fallback counts", never throw in render.
      const nodes =
        typeof useChat === 'function'
          ? useChat((snapshot) => (snapshot !== null && snapshot !== undefined && snapshot.legacy !== null && snapshot.legacy !== undefined ? snapshot.legacy.nodes : undefined))
          : undefined
      const stats = React.useMemo(() => (projected != null ? projected : deriveWindowStats(nodes)), [projected, nodes])
      const [openPill, setOpenPill] = React.useState(null)
      const [pinned, setPinned] = React.useState(null)
      const [series, setSeries] = React.useState(() => seriesFor(sessionId))
      const latest = React.useRef({ usage, stats })
      latest.current = { usage, stats }
      const hoverTimer = React.useRef(null)

      React.useEffect(() => {
        setSeries(seriesFor(sessionId))
      }, [sessionId])

      const push = React.useCallback(() => {
        const current = latest.current
        const next = pushSample(sessionId, current.usage, current.stats)
        if (next !== null) setSeries(next)
      }, [sessionId])

      // Change-driven sampling plus a heartbeat, because a rolling window needs
      // samples on the time axis even while the session is idle.
      React.useEffect(() => {
        push()
      }, [push, usage, stats])
      React.useEffect(() => {
        const timer = setInterval(push, SAMPLE_INTERVAL_MS)
        return () => clearInterval(timer)
      }, [push])

      const clearHoverTimer = React.useCallback(() => {
        if (hoverTimer.current !== null) {
          clearTimeout(hoverTimer.current)
          hoverTimer.current = null
        }
      }, [])

      // A pending hover open/close must not fire after the row unmounts
      // (session switch, dock collapse) — the timer would touch dead state.
      React.useEffect(() => clearHoverTimer, [clearHoverTimer])

      const hoverOpen = React.useCallback(
        (kind) => {
          if (!HOVER_OPEN) return
          clearHoverTimer()
          const target = kind
          hoverTimer.current = setTimeout(() => {
            hoverTimer.current = null
            setOpenPill((current) => current || target)
          }, HOVER_OPEN_DELAY_MS)
        },
        [clearHoverTimer]
      )

      const hoverClose = React.useCallback(() => {
        if (!HOVER_OPEN) return
        clearHoverTimer()
        hoverTimer.current = setTimeout(() => {
          hoverTimer.current = null
          setPinned((currentPinned) => {
            if (currentPinned === null) setOpenPill(null)
            return currentPinned
          })
        }, HOVER_CLOSE_DELAY_MS)
      }, [clearHoverTimer])

      // Live decode rate for the pill. Recomputed from the sample series rather
      // than from the cumulative projections, because a session average cannot
      // show whether the model is speeding up, stalling, or just finished.
      const speed = React.useMemo(() => liveSpeed(series, LIVE_WINDOW_MS), [series])

      const billed = usage === undefined || usage === null ? 0 : billedInput(usage)
      const total = usage === undefined || usage === null ? 0 : totalTokens(usage)
      const hasTokens = usage !== undefined && usage !== null && (billed > 0 || usage.outputTokens > 0)
      const cacheHit = hasTokens ? formatCacheHitPercent(usage.cacheReadTokens, billed) : null

      if (stats.steps === 0 && !hasTokens) return null

      const toggle = (kind, next) => {
        const value = next ? kind : null
        setPinned(value)
        setOpenPill(value)
      }

      const pillProps = (kind) => ({
        open: openPill === kind,
        setOpen: (next) => toggle(kind, next),
        hoverOpen: () => hoverOpen(kind),
        hoverClose
      })

      return h(
        'div',
        { className: 'dss-root', 'data-composer-stats': true },
        stats.steps > 0 ? h(TimePill, Object.assign({ key: 'time', stats, series, t, speed }, pillProps('time'))) : null,
        hasTokens ? h(UsagePill, Object.assign({ key: 'usage', usage, cacheHit, total, series, t }, pillProps('usage'))) : null
      )
    }

    /* ------------------------------------------------------------------ *
     * Plugin entry
     * ------------------------------------------------------------------ */

    /**
     * Plugin entry. Every step is independently guarded: a dictionary clash, a
     * missing `<head>`, or one refused registration must not stop the other
     * contributions, and nothing may throw out of `apply` into the host loader
     * (a failed plugin load would take the whole row down, not just this cell).
     */
    function apply(ctx) {
      try {
        // Each step owns its guard, so a refused dictionary/styles channel only
        // costs that step — the two dock cells still go in.
        try {
          ctx.effect(() => {
            try {
              return ctx.locale.register(NS, { zh: ZH, en: EN })
            } catch (error) {
              console.warn(`${NS}: could not register dictionaries`, error)
              return function noop() {}
            }
          }, `${NS}: dictionaries`)
        } catch (error) {
          console.warn(`${NS}: effect channel rejected the dictionaries`, error)
        }
        try {
          ctx.effect(() => {
            try {
              return injectStyles()
            } catch (error) {
              console.warn(`${NS}: could not inject styles`, error)
              return function noop() {}
            }
          }, `${NS}: styles`)
        } catch (error) {
          console.warn(`${NS}: effect channel rejected the styles`, error)
        }
        /** One dock cell each: the two built-in stat pills (shadowed so this row
         * owns their numbers and their charts), the token chip, and the two
         * duplicate rows other plugins paint into the same dock.
         *
         * Shadowing contract: `conversation.composer.dock` is a LIST slot whose
         * entry identity is (id, priority) and the LOWEST priority for an id is
         * the one that renders. An id therefore has to be the id the other plugin
         * actually registers: claiming a stale id does not shadow anything, it
         * silently ADDS a row — that is exactly the duplicated pill pair this
         * used to paint.
         *
         * Known limit: the built-in `performanceUsage` Detailed/Compact mode is
         * NOT carried over. Its store is private to ui-chat (`PerformanceUsagePolicy`
         * inside its module, injected as an entry-owned observable), so a client
         * plugin cannot reach it; this row always renders the Detailed layout.
         */
        const contributions = [
          {
            label: 'activity pill shadow',
            spec: {
              name: 'conversation.composer.dock',
              id: 'activity',
              order: 0,
              // Lower priority shadows ui-chat's built-in activity pill; the
              // official entry stays registered and returns if this one abdicates.
              priority: -1,
              locale: NS
            },
            // This row is the single source of the 轮/步/tok/s + cache-hit
            // pills: it also carries the rolling-window chart, and its numbers
            // come from the sessionStats projection rather than the ledger.
            // dsh-cost-meter's own pill row is shadowed a few lines below.
            component: StatsRow
          },
          {
            label: 'usage pill suppression',
            spec: {
              name: 'conversation.composer.dock',
              id: 'usage',
              order: 1,
              priority: -1
            },
            // Renders nothing: StatsRow already paints the token total and the
            // cache-hit reading (with their dialogs and charts), so the built-in
            // cell would be the identical second copy.
            component: EmptyCell
          },
          {
            label: 'token chip',
            spec: {
              name: 'conversation.composer.dock',
              id: 'stats-tokens',
              order: 10,
              locale: NS
            },
            component: TokenChip
          }
        ]
        if (SUPPRESS_COST_METER_LINE) {
          // Blank cost-meter's duplicate line without touching its package: the
          // cell is claimed at a lower priority and renders nothing.
          contributions.push({
            label: 'cost-meter line suppression',
            spec: {
              name: 'conversation.composer.dock',
              id: 'cost-meter',
              order: 5,
              priority: -1
            },
            component: EmptyCell
          })
        }
        if (SUPPRESS_COST_METER_STATS) {
          // Blank cost-meter's duplicate pill row without editing its package:
          // same slot, same id, lower priority, renders nothing.
          contributions.push({
            label: 'cost-meter statistics suppression',
            spec: {
              name: 'conversation.composer.dock',
              id: 'cost-meter-statistics',
              order: 1,
              priority: -1
            },
            component: EmptyCell
          })
        }
        for (const contribution of contributions) {
          const contribute = () => {
            try {
              return ctx.slots.register(contribution.spec, contribution.component)
            } catch (error) {
              console.warn(`${NS}: could not register ${contribution.label}`, error)
              return function noop() {}
            }
          }
          try {
            ctx.slots.inject('conversation.composer.dock', contribute)
          } catch (error) {
            console.warn(`${NS}: composer dock is unavailable`, error)
          }
        }
      } catch (error) {
        console.warn(`${NS}: plugin setup failed`, error)
      }
    }

    const api = {
      inject: ['slots', 'locale'],
      apply
    }

    // Test seam: the harness runs this bundle in a vm with the flag set so the
    // pure series/chart logic is unit-testable without a React renderer.
    if (globalThis.__DSS_TEST_SEAM__ === true) {
      api.__internals = {
        NS,
        WINDOWS,
        DEFAULT_WINDOW_ID,
        LIVE_WINDOW_MS,
        liveSpeed,
        MAX_POINTS,
        MAX_SAMPLES,
        COALESCE_MS,
        SAMPLE_INTERVAL_MS,
        HOVER_OPEN,
        HOVER_OPEN_DELAY_MS,
        HOVER_CLOSE_DELAY_MS,
        SUPPRESS_COST_METER_LINE,
        STYLES,
        EmptyCell,
        PERSIST_SAMPLES,
        CHART_WIDTH,
        CHART_HEIGHT,
        CHART_PAD_RIGHT,
        CHART_PAD_RIGHT_DUAL,
        AXIS_SPLIT_RATIO,
        sideTag,
        peakOf,
        PORTAL,
        emptySeries,
        sampleFrom,
        appendSample,
        windowBase,
        deriveWindowPoints,
        downsample,
        buildChartModel,
        windowMsOf,
        windowIdOf,
        windowLabel,
        billedInput,
        totalTokens,
        deriveWindowStats,
        formatTokens,
        formatExactTokens,
        formatTokensPerSecond,
        formatCacheHitPercent,
        formatDuration,
        niceCeil,
        niceStep,
        percentText,
        fitAxis,
        subscribeSeries,
        notifySeries,
        StatsRow,
        TimePill,
        UsagePill,
        TokenChip,
        ChartBlock,
        dialogElement,
        localeZH: ZH,
        localeEN: EN
      }
    }

    return api
  }
  })
} else if (typeof window !== 'undefined') {
  throw new Error('dsh-stats-sparkline: window.__ModuleLoader__ is missing; the browser half must load as a DSH client bundle')
}
