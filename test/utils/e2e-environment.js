/**
 * The e2e test environment: Node's, with one change — native addons are
 * loaded once per worker, as they are in a real process.
 *
 * WHY. Prisma's query engine is a Node-API addon. Prisma loads it with
 * `process.dlopen` and caches the result on `globalThis` so a process loads
 * it once. Under Jest every test file has its own `globalThis`, so every
 * file called `process.dlopen` again, from inside its own sandbox — and
 * Node-API ties each such load to the context it was made from and never
 * releases it. Each test file's whole module graph (Nest, Prisma, every
 * service) stayed reachable from a native handle for the life of the
 * worker: about 33 MB of heap per file, measured after a forced GC, until
 * `workerIdleMemoryLimit` recycled the worker (`jest --detectLeaks` flagged
 * every suite; a heap snapshot showed the sandbox context retained through
 * the engine's `QueryEngine` constructor in Node's global handles).
 *
 * The replacement below performs the real `process.dlopen` from this
 * module — outside every sandbox — the first time a library is asked for,
 * and gives every later caller (in any test file) the same exports. That is
 * the once-per-process behaviour Prisma's own cache intends.
 *
 * One more handle had the same effect: Prisma passes the engine a log
 * callback created inside the sandbox, and the engine keeps it as a strong
 * native reference until the engine object is finalized — which never
 * happens, because that engine object is reachable from the sandbox the
 * callback pins. `withCollectableLogger` hands the engine a forwarder made
 * here instead, which reaches the sandbox's callback only through a
 * `WeakRef`; the engine object itself keeps the callback alive. Every log
 * line still reaches Prisma while the engine exists, and once a test file
 * is done its sandbox can be collected.
 *
 * And one process-lifetime resource: prom-client's default metrics
 * (`LearningMetricsService`) start a GC `PerformanceObserver` and an
 * event-loop-delay monitor that nothing ever stops — right for a process,
 * which starts them once, but under Jest every test file starts its own,
 * and Node's global observer list then pins that file's sandbox. The
 * environment records what a test file opened and, at teardown, stops it —
 * what the end of a process would do. Nothing changes while the file runs.
 */
const { TestEnvironment } = require('jest-environment-node');
const perfHooks = require('node:perf_hooks');

/** What the running test file opened (files run one at a time per worker). */
let opened = null;

const nativeObserve = perfHooks.PerformanceObserver.prototype.observe;
perfHooks.PerformanceObserver.prototype.observe = function observe(...args) {
  opened?.observers.add(this);
  return nativeObserve.apply(this, args);
};
const nativeMonitorEventLoopDelay = perfHooks.monitorEventLoopDelay;
perfHooks.monitorEventLoopDelay = function monitorEventLoopDelay(...args) {
  const histogram = nativeMonitorEventLoopDelay.apply(this, args);
  opened?.histograms.add(histogram);
  return histogram;
};

const loadedAddons = new Map();

function withCollectableLogger(exports) {
  const NativeQueryEngine = exports.QueryEngine;
  if (typeof NativeQueryEngine !== 'function') return exports;
  function QueryEngine(options, logger, ...rest) {
    const target = typeof logger === 'function' ? new WeakRef(logger) : undefined;
    const forward = target ? (message) => target.deref()?.(message) : logger;
    const engine = new NativeQueryEngine(options, forward, ...rest);
    Object.defineProperty(engine, '__e2eLogger', { value: logger });
    return engine;
  }
  return { ...exports, QueryEngine };
}

function dlopenOnce(module, filename, flags) {
  let exports = loadedAddons.get(filename);
  if (exports === undefined) {
    const loaded = { exports: {} };
    process.dlopen(loaded, filename, flags);
    exports = withCollectableLogger(loaded.exports);
    loadedAddons.set(filename, exports);
  }
  module.exports = exports;
}

class E2EEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.global.process.dlopen = dlopenOnce;
  }

  async setup() {
    await super.setup();
    opened = { observers: new Set(), histograms: new Set() };
  }

  async teardown() {
    if (opened) {
      for (const observer of opened.observers) observer.disconnect();
      for (const histogram of opened.histograms) histogram.disable();
      opened = null;
    }
    await super.teardown();
  }
}

module.exports = E2EEnvironment;
