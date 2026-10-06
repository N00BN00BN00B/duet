import { parentPort, workerData } from 'node:worker_threads'
import { scanAll, type UsageCache } from './usageScan'

/** Runs a usage scan off the main thread and hands the updated cache back. */
const { claudeProjects, codexRoots, cache } = workerData as { claudeProjects: string; codexRoots: string[]; cache: UsageCache }
const result = scanAll(claudeProjects, codexRoots, cache, (done, total) => parentPort?.postMessage({ type: 'progress', done, total }))
parentPort?.postMessage({ type: 'done', cache: result })
