/**
 * CLI entry for `npm run push:legacy` — imports the normalised D365 exports into
 * a REMOTE atelier-api over HTTPS, for servers we have no shell on.
 *
 * The files under incoming/ are gitignored client PII, so they never reach the
 * server by deploy and `npm run import:legacy` there has nothing to read. This
 * runs on the workstation that holds them and streams them up in gzipped
 * batches to POST /admin/legacy/import/:entity (director-only).
 *
 * Usage:
 *   ATELIER_API_PASSWORD='…' npm run push:legacy -- \
 *     --api https://atelier-api.example.com --email liz@example.com
 *
 * Options: --dir <path> (default incoming/data-exports/normalized/),
 *          --batch <n> (default 1000), --only <entity>, --dry-run,
 *          --cookie '<name=value>' instead of --email/--password.
 *
 * Safe to re-run and safe to interrupt: every batch is an idempotent upsert on
 * the D365 GUID, so a resumed run re-applies rather than duplicates.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { LEGACY_ENTITY_ORDER } from './legacy-entities.js'

const DEFAULT_DIR = fileURLToPath(
  new URL('../../incoming/data-exports/normalized/', import.meta.url)
)
const DEFAULT_BATCH = 1000
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 500

/** Splits records into fixed-size batches. Exported for the test suite. */
export const chunk = (items, size) => {
  const batches = []
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size))
  }
  return batches
}

/**
 * `--flag value` pairs plus bare `--flag` booleans. Exported for the test suite.
 * Secrets are read from the environment by preference — a password in argv is
 * visible in the shell history and in `ps`.
 */
export const parseArgs = (argv, env = {}) => {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true
    } else {
      flags[key] = next
      i += 1
    }
  }
  const batch = Number(flags.batch ?? DEFAULT_BATCH)
  return Object.freeze({
    api: (flags.api ?? env.ATELIER_API_URL ?? '').replace(/\/+$/, ''),
    email: flags.email ?? env.ATELIER_API_EMAIL ?? '',
    password: env.ATELIER_API_PASSWORD ?? flags.password ?? '',
    cookie: flags.cookie ?? env.ATELIER_API_COOKIE ?? '',
    dir: flags.dir ?? DEFAULT_DIR,
    only: flags.only ?? '',
    batch: Number.isInteger(batch) && batch > 0 ? batch : DEFAULT_BATCH,
    dryRun: flags['dry-run'] === true,
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Signs in and returns the session cookie header value ("name=value"). */
const signIn = async ({ api, email, password }) => {
  const response = await fetch(`${api}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`sign-in failed (${response.status}): ${body.slice(0, 200)}`)
  }
  const setCookie = response.headers.getSetCookie?.() ?? []
  const cookie = setCookie.map((header) => header.split(';')[0]).join('; ')
  if (!cookie) throw new Error('sign-in returned no session cookie')
  const { user } = await response.json()
  if (user?.role !== 'director') {
    throw new Error(`${user?.email} is ${user?.role}; the import route is director-only`)
  }
  return cookie
}

/**
 * POSTs one gzipped batch, retrying transport failures and 5xx. A 4xx is a
 * problem with the data or the session, so it fails immediately — retrying it
 * would just burn the rate-limit bucket.
 */
const postBatch = async ({ api, cookie }, entity, records) => {
  const body = gzipSync(Buffer.from(JSON.stringify(records), 'utf8'))
  let lastError

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${api}/admin/legacy/import/${entity}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip', cookie },
        body,
      })
      if (response.ok) return await response.json()

      const detail = (await response.text()).slice(0, 300)
      const error = new Error(`${entity} batch rejected (${response.status}): ${detail}`)
      if (response.status < 500) throw error
      lastError = error
    } catch (error) {
      // A thrown 4xx must not be retried; re-throw it untouched.
      if (error.message.includes('rejected (4')) throw error
      lastError = error
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_MS * attempt)
  }
  throw lastError
}

const pushEntity = async (session, dir, entity, batchSize, dryRun) => {
  const records = JSON.parse(await readFile(join(dir, `${entity}.json`), 'utf8'))
  const batches = chunk(records, batchSize)
  process.stdout.write(`  ${entity}: ${records.length} records in ${batches.length} batches `)

  if (dryRun) {
    process.stdout.write('(dry run, nothing sent)\n')
    return 0
  }
  let sent = 0
  for (const batch of batches) {
    const summary = await postBatch(session, entity, batch)
    sent += summary.records
    process.stdout.write('.')
  }
  process.stdout.write(` ok (${sent})\n`)
  return sent
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2), process.env)
  if (!options.api) throw new Error('missing --api (or ATELIER_API_URL)')
  if (!options.cookie && (!options.email || !options.password)) {
    throw new Error('missing --email with ATELIER_API_PASSWORD (or --cookie)')
  }

  const files = new Set(await readdir(options.dir))
  const wanted = options.only ? [options.only] : LEGACY_ENTITY_ORDER
  const entities = wanted.filter((entity) => files.has(`${entity}.json`))
  if (entities.length === 0) {
    throw new Error(`no normalised exports in ${options.dir} — run: npm run convert:legacy`)
  }

  const cookie = options.dryRun && !options.cookie ? '' : options.cookie || (await signIn(options))
  console.log(`Pushing ${entities.length} entities to ${options.api}`)

  let total = 0
  for (const entity of entities) {
    total += await pushEntity({ api: options.api, cookie }, options.dir, entity, options.batch, options.dryRun)
  }
  console.log(`Remote legacy import complete — ${total} records applied.`)
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main().catch((error) => {
    console.error(`atelier-api legacy push failed: ${error.message}`)
    process.exitCode = 1
  })
}
