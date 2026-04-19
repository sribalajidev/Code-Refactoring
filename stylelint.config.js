/** @type {import('stylelint').Config} */
export default {
  extends: ['stylelint-config-standard'],
  plugins: ['@stylistic/stylelint-plugin', 'stylelint-scss'],

  overrides: [
    {
      files: ['**/*.scss'],
      customSyntax: 'postcss-scss'
    }
  ],

  rules: {
    // Empty blocks (report only)
    'block-no-empty': true,
    'no-duplicate-selectors': true,
    'color-no-invalid-hex': true,
    'property-no-unknown': true,
    'no-empty-source': true,
    'declaration-block-no-duplicate-properties': true,
    'declaration-no-important': true,
    'unit-allowed-list': ['px', 'rem', 'em'],

    // formatting
    '@stylistic/indentation': 2,
    '@stylistic/max-empty-lines': 1,
    '@stylistic/no-eol-whitespace': true,

    // braces
    '@stylistic/block-opening-brace-space-before': 'always',
    '@stylistic/block-closing-brace-newline-after': 'always',
    '@stylistic/block-closing-brace-empty-line-before': 'never',

    // spacing between rules
    'declaration-empty-line-before': 'never',
    'rule-empty-line-before': 'never',

    // colon spacing
    '@stylistic/declaration-colon-space-after': 'always',
    '@stylistic/declaration-colon-space-before': 'never',

    // declaration spacing
    '@stylistic/declaration-bang-space-before': 'always',
    '@stylistic/declaration-bang-space-after': 'never',

    // comma spacing (gradients, shadows, etc.)
    '@stylistic/value-list-comma-space-after': 'always',
    '@stylistic/value-list-comma-space-before': 'never'
  }
};