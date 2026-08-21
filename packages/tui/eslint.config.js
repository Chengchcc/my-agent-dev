// Vendored terminal library: control-character regexes are the protocol itself.

import tseslint from "typescript-eslint";
import root from "../../eslint.config.js";

export default tseslint.config(root, {
  files: ["src/**/*.ts"],
  rules: {
    "no-control-regex": "off",
    "no-useless-assignment": "off",
  },
});
