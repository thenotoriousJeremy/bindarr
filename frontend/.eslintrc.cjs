module.exports = {
  root: true,
  env: { browser: true, es2021: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
  ],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  settings: { react: { version: '18.2' } },
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    // The codebase intentionally omits runtime prop-types.
    'react/prop-types': 'off',
    // Every autoFocus moves focus to the field the user just asked for: the
    // first input of a dialog they opened (where WAI-ARIA's dialog pattern
    // wants focus to land) or an inline rename they started. None fires on
    // page load, which is what this rule guards against.
    'jsx-a11y/no-autofocus': 'off',
    // Toggle rows nest their text one span deeper than the default depth (2)
    // looks: <label><span><span>{t(...)}</span></span><input/></label>.
    'jsx-a11y/label-has-associated-control': ['error', { depth: 3 }],
  },
}
