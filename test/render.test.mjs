/**
 * Render smoke test.
 *
 * The stub React is stateless but synchronous, so the whole render path runs
 * once the tree is resolved: row gating, pill labels, the dialog subtree and
 * the SVG chart model. This is the closest thing to the GUI that can run
 * without a browser.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadBundle, sample, stubT } from './harness.mjs'

const usage = { uncachedInputTokens: 10, cacheReadTokens: 9990, cacheWriteTokens: 0, outputTokens: 50 }
const stats = { turns: 2, steps: 5, llmMs: 12000, toolMs: 300, ttftMs: 800, ttftSteps: 2, decodeMs: 5000, decodeTokens: 400 }

function fixtureSeries(internals) {
  const t0 = 1700000000000
  let series = internals.emptySeries()
  series = internals.appendSample(series, sample(t0, [0, 0, 0, 0], [0, 0]))
  series = internals.appendSample(series, sample(t0 + 3000, [10, 9990, 0, 50], [400, 400]))
  series = internals.appendSample(series, sample(t0 + 6000, [20, 19980, 0, 90], [900, 900]))
  return series
}

/**
 * Mini renderer: evaluates function components so the assertions can walk a
 * tree of host elements only. Our components take no children.
 */
function resolve(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(resolve)
  if (typeof node.type === 'function') return resolve(node.type(Object.assign({}, node.props, { children: node.children })))
  return { type: node.type, props: node.props, children: (node.children || []).map(resolve) }
}

function textOf(node, accumulator = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return accumulator
  if (typeof node === 'string' || typeof node === 'number') {
    accumulator.push(String(node))
    return accumulator
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, accumulator)
    return accumulator
  }
  if (Array.isArray(node.children)) for (const child of node.children) textOf(child, accumulator)
  return accumulator
}

function findByProp(node, prop) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByProp(child, prop)
      if (found !== null) return found
    }
    return null
  }
  if (node.props != null && node.props[prop] !== undefined) return node
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = findByProp(child, prop)
      if (found !== null) return found
    }
  }
  return null
}

function findAll(node, predicate, accumulator = []) {
  if (node === null || node === undefined || typeof node !== 'object') return accumulator
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, accumulator)
    return accumulator
  }
  if (predicate(node)) accumulator.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) findAll(child, predicate, accumulator)
  return accumulator
}

test('the row repaints both pills with the built-in wording', () => {
  const { api } = loadBundle()
  const internals = api.__internals
  const t = stubT(internals.localeZH)
  const useProjection = (key) => (key === 'tokenUsage' ? usage : stats)

  const raw = internals.StatsRow({ sessionId: 'session-1', useProjection, t })
  assert.equal(raw.type, 'div')
  assert.equal(raw.props['data-composer-stats'], true)
  const tree = resolve(raw)
  assert.equal(tree.children.length, 2)

  const text = textOf(tree).join('')
  assert.match(text, /2 轮 5 步/)
  assert.match(text, /80 tok\/s/)
  assert.match(text, /缓存命中 99\.9%/)
  assert.match(text, /10\.1K tok/)
})

test('the activity pill leads with the live decode rate, not the session average', () => {
  const t0 = 1700000000000
  // A persisted series whose trailing window decodes at 240/1300ms ≈ 185 tok/s,
  // while `stats` below says the session average is 80 tok/s.
  const persisted = {
    origin: sample(t0, [0, 0, 0, 0], [0, 0]),
    samples: [
      sample(t0, [0, 0, 0, 0], [0, 0]),
      sample(t0 + 2000, [10, 0, 0, 200], [1000, 200]),
      sample(t0 + 4000, [20, 0, 0, 240], [1300, 240])
    ]
  }
  const { api } = loadBundle({
    sessionStorage: {
      getItem: (key) => (key === 'dsh-stats-sparkline:v1:session-live' ? JSON.stringify(persisted) : null),
      setItem: () => {}
    }
  })
  const live = api.__internals
  const t = stubT(live.localeZH)
  const tree = resolve(
    live.StatsRow({
      sessionId: 'session-live',
      useProjection: (key) => (key === 'tokenUsage' ? usage : stats),
      t
    })
  )
  const text = textOf(tree).join('')
  assert.match(text, /2 轮 5 步/)
  assert.match(text, /185 tok\/s/, `live rate must lead the pill: ${text}`)
  assert.equal(/80 tok\/s/.test(text), false, 'the session average must not be the pill reading')
  assert.equal(live.LIVE_WINDOW_MS > 0, true)
})

test('the gauge dialog keeps the session average beside the live rate', () => {
  const { api } = loadBundle()
  const internals = api.__internals
  const t = stubT(internals.localeZH)
  const series = fixtureSeries(internals)
  const pill = resolve(
    internals.TimePill({
      stats,
      series,
      t,
      speed: 184.6,
      open: true,
      setOpen: () => {},
      hoverOpen: () => {},
      hoverClose: () => {}
    })
  )
  const panel = pill.children[1]
  const rows = textOf(findByProp(panel, 'data-session-stats-details')).join('')
  // Both readings stay reachable: the live one leads, the comparable history
  // reading (stats: 400 tokens over 5000ms = 80 tok/s) is still listed.
  assert.match(rows, /输出速度（最近 30 秒）/)
  assert.match(rows, /185 tok\/s/)
  assert.match(rows, /输出速度（本会话平均）/)
  assert.match(rows, /80 tok\/s/)
})

test('a session with no steps and no tokens renders nothing', () => {
  const { api } = loadBundle()
  const internals = api.__internals
  const t = stubT(internals.localeZH)
  const zero = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
  const noTokens = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  const tree = internals.StatsRow({
    sessionId: 'session-0',
    useProjection: (key) => (key === 'tokenUsage' ? noTokens : zero),
    t
  })
  assert.equal(tree, null)
})

test('the usage dialog keeps the built-in rows and appends the chart', () => {
  const { api } = loadBundle()
  const internals = api.__internals
  const t = stubT(internals.localeZH)
  const series = fixtureSeries(internals)

  const pill = resolve(
    internals.UsagePill({
      usage,
      cacheHit: '99.9',
      total: 10050,
      series,
      t,
      open: true,
      setOpen: () => {},
      hoverOpen: () => {},
      hoverClose: () => {}
    })
  )
  const panel = pill.children[1]
  assert.equal(panel.props.role, 'dialog')
  assert.equal(panel.props['aria-label'], 'Token 用量')

  const details = findByProp(panel, 'data-session-stats-usage')
  assert.notEqual(details, null, 'the dialog keeps the built-in detail-list hook')
  assert.equal(details.type, 'dl')
  const rows = textOf(details).join('')
  assert.match(rows, /缓存命中/)
  assert.match(rows, /99\.9%/)
  assert.match(rows, /未缓存输入/)
  assert.match(rows, /10 tok/)
  assert.match(rows, /9,990 tok/)
  assert.match(textOf(panel).join(''), /10,050 tok/, 'exact session total in the dialog title')

  const svg = findAll(panel, (node) => node.type === 'svg')[0]
  assert.notEqual(svg, undefined, 'the dialog carries an SVG chart')
  assert.equal(svg.props.role, 'img')
  assert.match(svg.props['aria-label'], /窗口/)
  const polylines = findAll(panel, (node) => node.type === 'polyline')
  assert.equal(polylines.length >= 2, true, 'hit line plus the session-cumulative line')
  assert.equal(polylines.every((line) => typeof line.props.points === 'string' && line.props.points.includes(' ')), true)
  // A fitted (zoomed) band must stay readable: top, middle and bottom labels.
  const axisTexts = findAll(panel, (node) => node.type === 'text' && node.props.className === 'dss-axis').map((node) => node.children[0])
  assert.equal(axisTexts.includes('100%'), true, `axis labels: ${axisTexts.join(',')}`)
  assert.equal(axisTexts.includes('99%'), true, `axis labels: ${axisTexts.join(',')}`)
  assert.match(textOf(panel).join(''), /纵轴 99–100%/)
})

test('the gauge pill dialog charts rates only, with the window still switchable', () => {
  const { api } = loadBundle()
  const internals = api.__internals
  const t = stubT(internals.localeZH)
  const series = fixtureSeries(internals)

  const pill = resolve(
    internals.TimePill({
      stats,
      series,
      t,
      open: true,
      setOpen: () => {},
      hoverOpen: () => {},
      hoverClose: () => {}
    })
  )
  const panel = pill.children[1]
  assert.equal(panel.props['aria-label'], '会话统计')
  const details = findByProp(panel, 'data-session-stats-details')
  assert.notEqual(details, null)
  const rows = textOf(details).join('')
  assert.match(rows, /模型用时/)
  assert.match(rows, /工具调用用时/)
  assert.match(rows, /首 token 平均/)
  assert.match(rows, /输出速度/)

  const text = textOf(panel).join('')
  // The window switcher stays; the metric switcher is gone.
  assert.match(text, /1分/)
  assert.match(text, /全程/)
  assert.equal(findAll(panel, (node) => node.type === 'svg').length, 1)
  // This pill charts rates and nothing else.
  assert.match(text, /消耗速率/)
  assert.match(text, /输出速度/)
  assert.equal(text.includes('窗口命中率'), false, 'no hit view on the gauge pill')
  assert.equal(text.includes('会话累计'), false, 'no hit view on the gauge pill')
  assert.equal(text.includes('缓存'), false, 'no breakdown view on the gauge pill')
})

test('an idle session shows the starved chart instead of a broken line', () => {
  const { api } = loadBundle()
  const internals = api.__internals
  const t = stubT(internals.localeZH)
  const chart = resolve(internals.ChartBlock({ series: internals.emptySeries(), view: 'hit', t }))
  assert.match(textOf(chart).join(''), /已采集 0 个样本/)
  assert.equal(findAll(chart, (node) => node.type === 'svg').length, 0)
})

test('with the anchor primitive present the dialog is portaled and measured', () => {
  const { api } = loadBundle({
    primitives: { useAnchoredPosition: () => null, useDismissOnOutsidePointer: () => {} }
  })
  const internals = api.__internals
  assert.equal(internals.PORTAL, true)
  const t = stubT(internals.localeZH)
  const series = fixtureSeries(internals)
  const pill = resolve(
    internals.UsagePill({
      usage,
      cacheHit: null,
      total: 10050,
      series,
      t,
      open: true,
      setOpen: () => {},
      hoverOpen: () => {},
      hoverClose: () => {}
    })
  )
  const body = pill.children[1]
  assert.equal(body.props.role, 'dialog')
  // The first pass has no placement yet, so the panel waits hidden at 0,0.
  assert.deepEqual(JSON.parse(JSON.stringify(body.props.style)), { visibility: 'hidden', left: 0, top: 0 })
  // Without a hit ratio the dialog drops that row, exactly like the built-in,
  // and a zero cache-write bucket keeps its row suppressed too.
  const rowsText = textOf(findByProp(body, 'data-session-stats-usage')).join('')
  assert.equal(rowsText.includes('缓存命中'), false)
  assert.match(rowsText, /未缓存输入/)
  assert.match(rowsText, /缓存读取/)
  assert.match(rowsText, /输出/)
  assert.equal(rowsText.includes('缓存写入'), false)
})

test('the token chip carries the breakdown and never a second hit rate', () => {
  const { api } = loadBundle()
  const internals = api.__internals
  const t = stubT(internals.localeZH)
  const chip = resolve(
    internals.TokenChip({
      sessionId: 'session-1',
      useProjection: (key) => (key === 'tokenUsage' ? usage : undefined),
      t
    })
  )
  const label = textOf(chip).join('')
  assert.equal(label.includes('缓存命中'), false, 'the row must keep exactly one hit-rate reading')
  assert.equal(label.includes('%'), false, 'no percentage in the chip either')
  assert.match(label, /输入 10/)
  assert.match(label, /缓存 10K/)
  assert.match(label, /输出 50/)
  // Closed by default: no dialog until the pointer arrives.
  assert.equal(chip.children[1], null)
})

test('the chip dialog charts the breakdown only, with three series', () => {
  // The chip reads samples from the shared series store; seed it the way a page
  // refresh would, through the sessionStorage mirror.
  const t0 = 1700000000000
  const stored = JSON.stringify({
    origin: { t: t0, u: [0, 0, 0, 0], s: [0, 0] },
    samples: [
      { t: t0, u: [0, 0, 0, 0], s: [0, 0] },
      { t: t0 + 3000, u: [10, 9990, 0, 50], s: [400, 400] },
      { t: t0 + 6000, u: [20, 19980, 0, 90], s: [900, 900] }
    ]
  })
  const { api } = loadBundle({
    forceOpen: true,
    sessionStorage: {
      getItem: (key) => (key.endsWith('session-1') ? stored : null),
      setItem: () => {}
    }
  })
  const internals = api.__internals
  const t = stubT(internals.localeZH)
  const chip = resolve(
    internals.TokenChip({
      sessionId: 'session-1',
      useProjection: (key) => (key === 'tokenUsage' ? usage : undefined),
      t
    })
  )
  const panel = chip.children[1]
  assert.equal(panel.props.role, 'dialog')
  assert.equal(panel.props['aria-label'], 'Token 构成')
  const details = findByProp(panel, 'data-session-stats-split')
  assert.notEqual(details, null, 'the chip dialog carries its own detail list')
  const rowsText = textOf(details).join('')
  assert.match(rowsText, /未缓存输入/)
  assert.match(rowsText, /缓存读取/)
  assert.match(rowsText, /输出/)
  assert.equal(rowsText.includes('缓存命中'), false)
  const text = textOf(panel).join('')
  // The breakdown is this seat's only view, and the window switcher still works.
  assert.match(text, /缓存/)
  assert.match(text, /输入/)
  assert.match(text, /输出/)
  assert.match(text, /1分/)
  assert.equal(text.includes('窗口命中率'), false, 'no hit view on the token chip')
  assert.equal(text.includes('消耗速率'), false, 'no rate view on the token chip')
  const polylines = findAll(panel, (node) => node.type === 'polyline')
  assert.equal(polylines.length >= 3, true, 'cache, input and output lines')
  const svg = findAll(panel, (node) => node.type === 'svg')[0]
  assert.match(svg.props['aria-label'], /输入/)
})

test('an idle session leaves the token chip out of the row', () => {
  const { api } = loadBundle()
  const internals = api.__internals
  const t = stubT(internals.localeZH)
  const chip = internals.TokenChip({
    sessionId: 'session-0',
    useProjection: () => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }),
    t
  })
  assert.equal(chip, null)
})

test('a split chart draws right-hand axis labels and tags the moved line', () => {
  // Cache reads at 5k tok/s against 600 tok/s of output: past the 4x split, so
  // the output curve moves to the second axis.
  const t0 = 1700000000000
  const stored = JSON.stringify({
    origin: { t: t0, u: [0, 0, 0, 0], s: [0, 0] },
    samples: [
      { t: t0, u: [0, 0, 0, 0], s: [0, 0] },
      { t: t0 + 10000, u: [40000, 50000, 0, 6000], s: [0, 0] },
      { t: t0 + 20000, u: [80000, 100000, 0, 12000], s: [0, 0] }
    ]
  })
  const { api } = loadBundle({
    forceOpen: true,
    sessionStorage: {
      getItem: (key) => (key.endsWith('session-1') ? stored : null),
      setItem: () => {}
    }
  })
  const internals = api.__internals
  const t = stubT(internals.localeZH)
  const chip = resolve(
    internals.TokenChip({
      sessionId: 'session-1',
      useProjection: (key) => (key === 'tokenUsage' ? usage : undefined),
      t
    })
  )
  const panel = chip.children[1]
  const texts = findAll(panel, (node) => node.type === 'text' && node.props.className === 'dss-axis')
  const rightSide = texts.filter((node) => node.props.textAnchor === 'start' && node.props.style !== undefined)
  assert.equal(rightSide.length, 3, `expected three right-axis labels, got ${rightSide.length}`)
  assert.equal(rightSide.every((node) => typeof node.props.style.fill === 'string'), true)
  const labels = textOf(panel).join('')
  assert.match(labels, /输出（右轴）/, 'the legend must say which line left the shared axis')
  assert.match(labels, /二号轴/, 'the footer must name both scales')
})

test('a nullish or differently-shaped host snapshot degrades instead of throwing', () => {
  const { api } = loadBundle()
  const internals = api.__internals
  const t = stubT(internals.localeZH)
  const cases = [
    { name: 'both projections null', props: { useProjection: () => null } },
    { name: 'both projections undefined', props: { useProjection: () => undefined } },
    {
      name: 'chat snapshot undefined',
      props: { useProjection: () => undefined, useChat: (selector) => selector(undefined) }
    },
    {
      name: 'chat snapshot without legacy',
      props: { useProjection: () => undefined, useChat: (selector) => selector({}) }
    },
    {
      name: 'chat snapshot with legacy but no nodes',
      props: { useProjection: () => undefined, useChat: (selector) => selector({ legacy: {} }) }
    },
    {
      name: 'usage present, sessionStats missing',
      props: { useProjection: (key) => (key === 'tokenUsage' ? usage : undefined), useChat: (selector) => selector(null) }
    }
  ]
  for (const scenario of cases) {
    const tree = internals.StatsRow(
      Object.assign({ sessionId: 'session-1', t }, scenario.props)
    )
    // Rendering either succeeds or yields nothing — never a throw.
    assert.equal(tree === null || tree.type === 'div', true, `${scenario.name}: unexpected render result`)
  }
  // The last case keeps the token pill: the usage projection alone is enough.
  const withUsage = resolve(
    internals.StatsRow(Object.assign({ sessionId: 'session-1', t }, cases[5].props))
  )
  const text = textOf(withUsage).join('')
  assert.match(text, /缓存命中 99\.9%/, 'the hit reading survives a missing sessionStats')
  assert.equal(text.includes('轮'), false, 'counts are omitted when sessionStats and chat are both absent')
})
