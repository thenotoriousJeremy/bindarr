import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default [
  { ignores: ['dist/', 'android/', 'ios/', 'src/device/generated/'] },
  js.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat['jsx-runtime'],
  jsxA11y.flatConfigs.recommended,
  {
    // Flat config lints .js/.mjs/.cjs on its own; .jsx only once a block names it.
    files: ['**/*.{js,jsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node, ...globals.es2021 },
    },
    settings: { react: { version: '19.3' } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      // The two rules plugin:react-hooks/recommended carried before v6. Its preset
      // now adds the React Compiler rules too; adopting those is its own change.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
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
  },
  // Node scripts written as CommonJS.
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
];
