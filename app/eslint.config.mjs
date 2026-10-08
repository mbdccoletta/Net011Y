// Lint for the two classes of mistake that reach production through a green type check and a clean
// build, because both are about *when* code runs rather than what its types are:
//
//   - a hook called after a conditional return, which blows the page up on the render where the early
//     return fires ("Rendered more hooks than during the previous render"). It happened three times;
//     scripts/grail/hooks_after_return.mjs was the stopgap and this is the real check.
//   - a const read above its own declaration, which throws on the first render ("Cannot access 'A'
//     before initialization"). That one shipped: the live map died on every render for one version.
//
// Everything else is left to the type checker and to review. A lint run that reports style opinions
// buries the two findings that actually break the app.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "ui/app/data/geo/**"] },
  {
    files: ["ui/**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommended],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // the two that matter
      "react-hooks/rules-of-hooks": "error",
      "no-use-before-define": "off",
      "@typescript-eslint/no-use-before-define": ["error", {
        // functions and types are hoisted or erased; what throws is a value read before its line
        functions: false, classes: true, variables: true, typedefs: false, enums: true,
        ignoreTypeReferences: true,
      }],
      // a stale dependency shows wrong data rather than crashing: worth seeing, not worth blocking
      "react-hooks/exhaustive-deps": "warn",

      // the recommended set carries opinions this codebase has already decided against
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
