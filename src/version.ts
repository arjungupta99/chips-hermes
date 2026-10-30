import { readFileSync } from "node:fs";

/** This bridge's own version, read from its package.json, which sits beside `src/` and `dist/` alike. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
