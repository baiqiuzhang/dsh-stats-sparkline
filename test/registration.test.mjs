/**
 * Bundle shape and contribution contract.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { loadBundle, createCtx } from './harness.mjs'

const NS = 'dsh-stats-sparkline'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Cross-realm values carry the vm's prototypes; compare plain JSON clones. */
const plain = (value) => JSON.parse(JSON.stringify(value))

test('the manifest stays installable and publishable', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.name, NS)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.private, undefined, 'a private package cannot be published')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(Array.isArray(pkg.dsh.client.inject), true)
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  // Every promised file must exist in the tarball's file list.
  for (const entry of pkg.files) assert.equal(existsSync(join(ROOT, entry)), true, `missing ${entry}`)
  // The keywords are how the GitHub/npm indexes find a dsh plugin.
  assert.equal(pkg.keywords.includes('dsh-plugin'), true)
  assert.equal(pkg.publishConfig.access, 'public')
})

test('bundle registers a classic-script factory under its package name', () => {
  const { id, api, source } = loadBundle()
  assert.equal(id, NS)
  // The loader contract, wrapped in the browser/tooling guard.
  assert.match(source, /window\.__ModuleLoader__/)
  assert.match(source, /\.load\(\{/)
  assert.match(source, /typeof window === 'undefined'/)
  // A client bundle is evaluated as a classic script: no module syntax at all.
  assert.equal(/^\s*import\s/m.test(source), false, 'bundle must not contain import statements')
  assert.equal(/^\s*export\s/m.test(source), false, 'bundle must not contain export statements')
  assert.deepEqual(plain(api.inject), ['slots', 'locale'])
  assert.equal(typeof api.apply, 'function')
})

test('production bundles expose no test seam', () => {
  const { api } = loadBundle({ seam: false })
  assert.equal(api.__internals, undefined)
})

test('apply registers dictionaries, styles and all five dock cells', () => {
  const { api, appended } = loadBundle()
  const { ctx, injections, registrations, effects, locales } = createCtx()
  api.apply(ctx)

  assert.deepEqual(injections, [
    'conversation.composer.dock',
    'conversation.composer.dock',
    'conversation.composer.dock',
    'conversation.composer.dock',
    'conversation.composer.dock'
  ])
  assert.equal(registrations.length, 5)
  // The ids MUST be the ones ui-chat itself registers. A list slot keys an entry
  // by (id, priority), so a stale id does not shadow — it adds a second row,
  // which is the duplicated pill pair this plugin used to paint.
  assert.deepEqual(plain(registrations[0].spec), {
    name: 'conversation.composer.dock',
    id: 'activity',
    order: 0,
    priority: -1,
    locale: NS
  })
  // The built-in usage cell is claimed and renders nothing: StatsRow above
  // already draws the token total plus the cache-hit reading and their charts.
  assert.deepEqual(plain(registrations[1].spec), {
    name: 'conversation.composer.dock',
    id: 'usage',
    order: 1,
    priority: -1
  })
  assert.equal(registrations[1].component(), null, 'the claimed pill must render nothing')
  // The token chip owns a fresh id: only the two stat pills are shadows, so the
  // chip can never displace the built-in row (or another plugin's cell).
  assert.deepEqual(plain(registrations[2].spec), {
    name: 'conversation.composer.dock',
    id: 'stats-tokens',
    order: 10,
    locale: NS
  })
  // The duplicate cost-meter line is claimed the same official way and renders
  // nothing — no other plugin is edited and no DOM is read.
  assert.deepEqual(plain(registrations[3].spec), {
    name: 'conversation.composer.dock',
    id: 'cost-meter',
    order: 5,
    priority: -1
  })
  assert.equal(registrations[3].component(), null, 'the claimed cell must render nothing')
  // cost-meter's pill row is claimed the same way, so the composer carries one
  // set of 轮/步/tok/s + cache-hit numbers instead of two.
  assert.deepEqual(plain(registrations[4].spec), {
    name: 'conversation.composer.dock',
    id: 'cost-meter-statistics',
    order: 1,
    priority: -1
  })
  assert.equal(registrations[4].component(), null, 'the claimed pill row must render nothing')
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(typeof registrations[2].component, 'function')
  assert.notEqual(registrations[0].component, registrations[2].component)

  assert.equal(locales.length, 1)
  assert.equal(locales[0].namespace, NS)
  assert.equal(typeof locales[0].dictionaries.zh, 'object')
  assert.equal(typeof locales[0].dictionaries.en, 'object')
  for (const key of ['counts', 'cacheHit', 'tokensPerSecond', 'tokenCount', 'thousand', 'million', 'groupSeparator']) {
    assert.equal(typeof locales[0].dictionaries.zh[key], 'string', `zh dictionary must carry ${key}`)
    assert.equal(typeof locales[0].dictionaries.en[key], 'string', `en dictionary must carry ${key}`)
  }
  // Pill wording must stay identical to the built-in stats line.
  assert.equal(locales[0].dictionaries.zh.counts, '{turns} 轮 {steps} 步')
  assert.equal(locales[0].dictionaries.zh.cacheHit, '缓存命中 {percent}%')
  assert.equal(locales[0].dictionaries.en.counts, '{turns} turns {steps} steps')

  assert.equal(appended.length, 1)
  assert.equal(appended[0].dataset.pluginCss, `${NS}/pills`)
  assert.equal(effects.length, 2)
})

test('the chip shares the pill row typography it cannot inherit', () => {
  const { api } = loadBundle()
  const styles = api.__internals.STYLES
  // The chip is its own dock cell, so the type metrics must be declared on the
  // anchor as well — that is exactly the "chip looks bigger" regression.
  const typography = /\.dss-root,\.dss-anchor\{font-size:[^}]*line-height:[^}]*\}/
  assert.match(styles, typography)
  assert.match(styles, /\.dss-pill\{[^}]*font:inherit/)
  assert.match(styles, /\.dss-pill\{[^}]*font-variant-numeric:tabular-nums/)
})

test('cost-meter suppression is a documented switch, on by default', () => {
  const { api } = loadBundle()
  const internals = api.__internals
  assert.equal(internals.SUPPRESS_COST_METER_LINE, true)
  assert.equal(typeof internals.EmptyCell, 'function')
  assert.equal(internals.EmptyCell(), null)
})

test('a missing primitive set degrades instead of throwing', () => {
  const { api } = loadBundle({ primitives: {}, withoutReactDom: true })
  const { ctx, registrations } = createCtx()
  assert.doesNotThrow(() => api.apply(ctx))
  assert.equal(registrations.length, 5)
})

test('a hostile slot registry is survived and reported', () => {
  const { api, warnings } = loadBundle()
  const injectFailure = createCtx({ injectThrows: true })
  assert.doesNotThrow(() => api.apply(injectFailure.ctx))
  const registerFailure = createCtx({ registerThrows: true })
  assert.doesNotThrow(() => api.apply(registerFailure.ctx))
  // Five contributions per apply, all ten failures reported without throwing.
  assert.equal(warnings.length, 10)
})

test('a broken locale or effect channel cannot take the plugin down', () => {
  const { api, warnings } = loadBundle()
  const localeFailure = createCtx({ localeThrows: true })
  assert.doesNotThrow(() => api.apply(localeFailure.ctx))
  // Dictionaries failed, but all five dock cells still went in.
  assert.equal(localeFailure.registrations.length, 5)
  assert.equal(localeFailure.locales.length, 0)

  const effectFailure = createCtx({ effectThrows: true })
  assert.doesNotThrow(() => api.apply(effectFailure.ctx))
  // Both dictionary and styles steps are reported, and the dock cells still land.
  assert.equal(effectFailure.registrations.length, 5)
  assert.equal(warnings.length, 3)
})

test('outside a browser the bundle stays inert instead of throwing', () => {
  const result = loadBundle({ withoutWindow: true })
  assert.equal(result.inert, true)
  assert.equal(result.api, null)
  assert.match(result.source, /window\.__ModuleLoader__/)
})

test('the seam exposes the row components and the constants the tests rely on', () => {
  const { api } = loadBundle()
  const internals = api.__internals
  assert.equal(internals.NS, NS)
  assert.equal(typeof internals.StatsRow, 'function')
  assert.equal(typeof internals.TokenChip, 'function')
  assert.equal(typeof internals.ChartBlock, 'function')
  assert.equal(internals.HOVER_OPEN, true)
  assert.equal(internals.CHART_WIDTH, 264)
  assert.equal(internals.WINDOWS.length, 4)
})
