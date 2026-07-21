import Fastify from 'fastify'

export const buildApp = ({ pool, logLevel = 'info', logger = true } = {}) => {
  if (!pool) {
    throw new Error('buildApp requires a pg pool')
  }

  const app = Fastify({
    logger: logger ? { level: logLevel } : false,
  })

  app.get('/health', async (request, reply) => {
    try {
      await pool.query('SELECT 1')
      return { ok: true, db: true }
    } catch (error) {
      request.log.error({ err: error }, 'health check: database unreachable')
      reply.code(503)
      return { ok: false, db: false }
    }
  })

  return app
}
