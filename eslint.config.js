import js from '@eslint/js'
import globals from 'globals'

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['test/**'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // src/seed/data/ is vendored (CRM copies) + generated (price-lists.json) — not house code.
    ignores: ['node_modules/', 'src/seed/data/'],
  },
]
