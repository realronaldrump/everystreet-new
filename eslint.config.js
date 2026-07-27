import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/vendor/**",
      "**/*.min.js",
    ],
  },
  {
    ...js.configs.recommended,
    files: ["static/js/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.jquery,
        bootstrap: "readonly",
        Chart: "readonly",
        CountUp: "readonly",
        dayjs: "readonly",
        deck: "readonly",
        google: "readonly",
        L: "readonly",
        mapboxgl: "readonly",
        MapboxGeocoder: "readonly",
        showNotification: "readonly",
        Swup: "readonly",
        turf: "readonly",
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
];
