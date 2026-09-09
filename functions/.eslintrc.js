module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:import/errors",
    "plugin:import/warnings",
    "plugin:import/typescript",
    "google",
    "plugin:@typescript-eslint/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["tsconfig.json", "tsconfig.dev.json"],
    sourceType: "module",
  },
  ignorePatterns: [
    "**/*.js", // Ignore all JavaScript files.
    "/lib/**/*", // Ignore built files.
    "/generated/**/*", // Ignore generated files.
    "/node_modules/**/*", // Ignore node_modules
    "/dist/**/*", // Ignore dist files.
    "/coverage/**/*", // Ignore coverage files.
  ],
  plugins: ["@typescript-eslint", "import"],
  rules: {
    "no-trailing-spaces": "off",
    "require-jsdoc": "off",
    "valid-jsdoc": "off",
    "object-curly-spacing": "off",
    quotes: ["error", "single"],
    "import/no-unresolved": 0,
    indent: ["error", 4],
    "max-len": ["error", { code: 160 }],
  },
};
