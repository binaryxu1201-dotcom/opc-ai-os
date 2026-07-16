import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: [".next/**", "next-env.d.ts", "out/**", "build/**"] },
  {
    files: ["load/**/*.js"],
    languageOptions: {
      globals: {
        __ENV: "readonly",
        __VU: "readonly",
        __ITER: "readonly",
        sleep: "readonly",
        check: "readonly",
        http: "readonly",
        export: "writable",
        options: "writable"
      }
    }
  }
);
