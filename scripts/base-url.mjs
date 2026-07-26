/* Where the console is mounted, spelled one way.
 *
 * Kept apart from build.mjs so that vite.config.mts can import it: Vite bundles
 * the config's relative imports, and pulling in a module that starts a build
 * would start one inside the build it is configuring. */

/**
 * `console` / `/console` / `/console/` all mean the same thing. An absolute URL
 * is left alone: the assets are hosted elsewhere and the app still lives at /.
 * @param {string} value
 * @returns {string}
 */
export function normalizeBase(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return value.endsWith('/') ? value : `${value}/`;
  }
  return `/${value}/`.replace(/\/{2,}/g, '/');
}
