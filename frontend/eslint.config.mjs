import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  // keep Next’s recommended presets
  ...compat.extends("next/core-web-vitals", "next/typescript"),

  // ✅ our overrides: make “any” a warning, not an error
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      // optional but common for your repo:
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    },
  },
];

export default eslintConfig;
