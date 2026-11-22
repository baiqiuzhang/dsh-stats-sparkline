/**
 * Locale hygiene: the two dictionaries must stay in lockstep, no key may be
 * defined without a reader, and every `{placeholder}` a template asks for must
 * actually be passed at its call site.
 *
 * The bundle source is the truth here: dictionary keys are written unquoted
 * (`key: '…'`) while call sites quote them (`t('key', …)`), so a quoted
 * occurrence is exactly "somebody reads this key".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadBundle } from './harness.mjs'

const { api, source } = loadBundle()
const zh = api.__internals.localeZH
const en = api.__internals.localeEN

test('Chinese and English dictionaries carry the same keys', () => {
  assert.equal(Object.keys(zh).length > 0, true)
  assert.equal(Object.keys(zh).sort().join(','), Object.keys(en).sort().join(','))
})

test('every dictionary key is read by the bundle', () => {
  const orphans = Object.keys(zh).filter((key) => !source.includes(`'${key}'`))
  assert.deepEqual(orphans, [], `unused locale keys: ${orphans.join(', ')}`)
})

test('every template placeholder is passed at its call site', () => {
  const problems = []
  for (const [key, value] of Object.entries(zh)) {
    if (typeof value !== 'string') continue
    const placeholders = Array.from(value.matchAll(/\{(\w+)\}/g), (match) => match[1])
    if (placeholders.length === 0) continue
    const callIndex = source.indexOf(`t('${key}'`)
    if (callIndex < 0) {
      problems.push(`${key}: no call site`)
      continue
    }
    // A bounded slice is enough for our multi-line calls and sidesteps brace
    // matching inside nested objects (e.g. `t('tokenCount', { count: … })`).
    const callSite = source.slice(callIndex, callIndex + 400)
    for (const placeholder of placeholders) {
      if (!new RegExp(`\\b${placeholder}\\s*:`).test(callSite)) problems.push(`${key}: {${placeholder}}`)
    }
  }
  assert.deepEqual(problems, [], `templates render literal braces: ${problems.join(', ')}`)
})
