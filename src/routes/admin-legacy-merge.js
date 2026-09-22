// POST /admin/legacy/merge — the cutover merge, behind an authenticated request.
//
// Why it exists: `npm run merge:legacy` (src/seed/merge-legacy.js → src/legacy/
// merge.js) is what promotes the Dynamics staging tables into the LIVE tables
// the CRM's working sections read. On the deployed API it runs only inside the
// deploy script — so a bundle the office loads through the CRM's import panel
// AFTER the last deploy sits in the Archive and nowhere else until somebody
// deploys again, and if that deploy-time run fails the failure is written to a
// shell nobody reads. This is the same merge (`mergeLegacy`, unchanged) as the
// one request the CRM's Archive page can make, with the summary the CLI prints
// returned as JSON and a failure's reason returned to the person who clicked.
//
// DIRECTOR-only, like the import it follows: it writes trade accounts,
// contacts, dockets, the catalogue and stock quantities in one go. Back office
// may browse the staging tables; promoting them is the narrower privilege.
//
// ONE AT A TIME. The merge is re-runnable (every table it writes carries a
// D365 key), but two runs interleaved would race the same upserts for no gain,
// so a second request while one is in flight is refused with 409 rather than
// queued. The lock is per process, which is the deployment: pm2 runs one.

import { mergeLegacy } from '../legacy/merge.js'

const bodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // Raise a `brands` row for each D365 range that carries stock and has no
    // catalogue house (the CLI's `--create-houses`). The CRM sends true — the
    // deploy script does — so the office's own stock lines land; the default
    // keeps the colour importer's rule that a house is never created silently.
    create_houses: { type: 'boolean', default: false },
  },
}

// `merge` is injectable so the one-at-a-time rule can be proven with a merge
// the test holds open; production never passes it.
export const adminLegacyMergeRoutes = async (app, { pool, merge = mergeLegacy }) => {
  const director = app.guards.requireRole('director')

  // The in-flight run, or null. Module state would outlive a test's app; plugin
  // state is scoped to the instance that registered it.
  let running = null

  app.post(
    '/admin/legacy/merge',
    { preHandler: director, schema: { body: bodySchema } },
    async (request, reply) => {
      if (running) {
        reply.code(409)
        return { error: 'A legacy merge is already running. Wait for it to finish, then reload.' }
      }
      const createHouses = request.body?.create_houses === true
      const startedAt = Date.now()
      running = merge(pool, { createHouses })
      try {
        const summary = await running
        request.log.info(
          {
            createHouses,
            ms: Date.now() - startedAt,
            accounts: summary.accounts.created,
            contacts: summary.contacts.created,
            reserveLines: summary.reserves.lines,
            colourways: summary.catalogue.colourways,
            stocked: summary.stock.stocked,
          },
          'legacy merge applied'
        )
        return { summary, create_houses: createHouses, ms: Date.now() - startedAt }
      } catch (error) {
        // Each step of the merge is all-or-nothing in its own transaction (see
        // merge.js), so a failure leaves nothing half-written and the run is
        // safe to repeat once the cause is fixed. The reason is what makes it
        // fixable, so it goes to the person who clicked, not only to the log.
        request.log.error({ err: error, createHouses }, 'legacy merge failed')
        reply.code(500)
        return {
          error: 'Legacy merge failed.',
          message: `Legacy merge failed: ${error.message}. Each step is all-or-nothing, so nothing is half-written; fix the cause and run it again.`,
        }
      } finally {
        running = null
      }
    }
  )
}
