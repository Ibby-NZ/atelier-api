import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Test files run migrations against the shared local DB; node-pg-migrate
    // takes an advisory lock, so parallel files collide. Suite is small — serialize.
    fileParallelism: false,
  },
})
