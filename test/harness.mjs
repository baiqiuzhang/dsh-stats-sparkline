/**
 * Test harness for the dsh-stats-sparkline browser half.
 *
 * The bundle is a classic script that registers a closure factory on
 * `window.__ModuleLoader__`. Loading it in a `node:vm` context lets the tests
 * read the factory, run `apply` against a recording Cordis context, and reach
 * the pure series/chart logic through the bundle's test seam — no React
 * renderer, no jsdom, no build step.
 */
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_PATH = join(ROOT, 'client.js')

/**
 * Minimal React stand-in: enough for module-level code, not for rendering.
 * `forceOpen` flips every boolean `useState(false)` to true, which is how a
 * test opens an internally-owned dialog without a real renderer.
 */
export function createStubReact(options = {}) {
  const noop = () => undefined
  const forceOpen = options.forceOpen === true
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    memo: (component) => component,
    useState: (initial) => {
      const value = typeof initial === 'function' ? initial() : initial
      return [forceOpen && value === false ? true : value, noop]
    },
    useRef: (initial) => ({ current: initial }),
    useEffect: noop,
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback
  }
}

/** Load the bundle and return its captured definition and factory product. */
export function loadBundle(options = {}) {
  const source = readFileSync(SOURCE_PATH, 'utf8')
  let captured = null
  const appended = []
  const warnings = []
  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      }
    },
    sessionStorage: options.sessionStorage || { getItem: () => null, setItem: () => {} }
  }
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, appendChild() {} }),
    head: { appendChild: (element) => appended.push(element) },
    body: {},
    addEventListener() {},
    removeEventListener() {}
  }
  const sandbox = {
    console: Object.assign({}, console, { warn: (...args) => warnings.push(args) }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    __DSS_TEST_SEAM__: options.seam !== false,
    document: documentStub
  }
  // `withoutWindow` models a non-browser evaluation (node tooling / SSR import).
  if (options.withoutWindow !== true) sandbox.window = windowStub
  const context = createContext(sandbox)
  new Script(source, { filename: SOURCE_PATH }).runInContext(context)
  if (captured === null) {
    if (options.withoutWindow === true) return { id: null, api: null, appended, warnings, source, inert: true }
    throw new Error('bundle did not call window.__ModuleLoader__.load')
  }

  const modules = {
    react: options.react || createStubReact({ forceOpen: options.forceOpen === true }),
    'react-dom': options.reactDom || { createPortal: (element) => element },
    '@deepseek-ai/dsh-client-ui-primitives': options.primitives || {}
  }
  const api = captured.factory((id) => {
    if (id === 'react-dom' && options.withoutReactDom === true) throw new Error(`Cannot find module '${id}'`)
    if (!Object.prototype.hasOwnProperty.call(modules, id)) throw new Error(`unexpected require("${id}")`)
    return modules[id]
  })
  return { id: captured.id, api, appended, warnings, source }
}

/** Recording Cordis context: what a contribution actually registered. */
export function createCtx(options = {}) {
  const injections = []
  const registrations = []
  const effects = []
  const locales = []
  const ctx = {
    effect(callback) {
      if (options.effectThrows === true) throw new Error('effect unavailable')
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
    slots: {
      inject(key, callback) {
        injections.push(key)
        if (options.injectThrows === true) throw new Error('slot unavailable')
        callback()
        return () => {}
      },
      register(spec, component) {
        if (options.registerThrows === true) throw new Error('duplicate registration')
        registrations.push({ spec, component })
        return () => {}
      }
    },
    locale: {
      register(namespace, dictionaries) {
        if (options.localeThrows === true) throw new Error('locale namespace clash')
        locales.push({ namespace, dictionaries })
        return () => {}
      }
    }
  }
  return { ctx, injections, registrations, effects, locales }
}

/** Locale seat stand-in: `{name}` interpolation only. */
export function stubT(dictionary = {}) {
  return (key, params) => {
    const template = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    )
  }
}

/** Cumulative sample literal. */
export function sample(t, u, s) {
  return { t, u, s }
}

export { SOURCE_PATH }
