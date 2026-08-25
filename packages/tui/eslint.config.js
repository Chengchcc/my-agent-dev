// Vendored terminal library: control-character regexes are the protocol itself.
// The mermaid-ascii subtree is third-party vendored code and is not linted.

import tseslint from "typescript-eslint";
import root from "../../eslint.config.js";

export default tseslint.config(
  {
    ignores: ["src/vendor/**"],
  },
  root,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-control-regex": "off",
      "no-useless-assignment": "off",
    },
  },
);
