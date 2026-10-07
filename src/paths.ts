import fs from "node:fs";
import path from "node:path";

/**
 * Repository root (the directory holding package.json). Works both from src/ (tsx, tests, scripts)
 * and from the compiled dist/src/ (production `npm start`), unlike a fixed `__dirname/../..`.
 */
export const PROJECT_ROOT = (() => {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
  return dir;
})();
