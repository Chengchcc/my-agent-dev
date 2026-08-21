// Vendored terminal library: control-character regexes are the protocol itself.
import root from "../../eslint.config.js";
import tseslint from "typescript-eslint";

export default tseslint.config(root, {
  files: ["src/**/*.ts"],
  rules: {
    "no-control-regex": "off",
    "no-useless-assignment": "off",
  },
});
