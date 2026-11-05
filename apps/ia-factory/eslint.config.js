import { config } from "@workspace/eslint-config/base";
import globals from "globals";

/**
 * Lint rules for the IA Factory app.
 *
 * @remarks
 * The app runs on Node (eve runtime and authored tools), so Node globals are
 * in scope. The build output and the discovery artifacts are generated code,
 * never reviewed, so they are ignored.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export default [
  ...config,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    ignores: [".output/**", ".eve/**", "node_modules/**", "dist/**"],
  },
];
