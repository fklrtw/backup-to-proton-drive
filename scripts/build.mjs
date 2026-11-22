import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/**
 * Resolves the repository root directory relative to this build script.
 */
const scriptFilePath = fileURLToPath(import.meta.url);
const repositoryRootDirectory = path.resolve(path.dirname(scriptFilePath), '..');
const packageManifestPath = path.join(repositoryRootDirectory, 'package.json');
const entryPointPath = path.join(repositoryRootDirectory, 'src', 'index.ts');
const outputFilePath = path.join(repositoryRootDirectory, 'dist', 'index.js');
const nodeOpenPgpEntryPath = path.join(
  repositoryRootDirectory,
  'node_modules',
  'openpgp',
  'dist',
  'node',
  'openpgp.mjs',
);

/**
 * `@protontech/crypto` imports `"openpgp/lightweight"`, whose `package.json` export map
 * only defines a `"browser"` condition. Redirect it to `@protontech/openpgp`'s Node ESM
 * entrypoint so `esbuild` produces a pure Node.js bundle without browser polyfills.
 */
const openpgpNodeResolvePlugin = {
  name: 'resolve-openpgp-for-node',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^openpgp\/lightweight$/ }, () => ({
      path: nodeOpenPgpEntryPath,
    }));
  },
};

/**
 * Bundles the TypeScript CLI entrypoint and all dependencies (including raw `.ts`
 * exports from `@protontech/crypto`) into a single Node.js ESM executable bundle.
 */
async function buildApplicationBundle() {
  const packageManifestRaw = await fs.readFile(packageManifestPath, 'utf8');
  const packageManifest = JSON.parse(packageManifestRaw);
  const applicationVersion =
    typeof packageManifest.version === 'string' && packageManifest.version.length > 0
      ? packageManifest.version
      : '0.1.0';

  await esbuild.build({
    entryPoints: [entryPointPath],
    outfile: outputFilePath,
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'esm',
    sourcemap: true,
    logLevel: 'info',
    plugins: [openpgpNodeResolvePlugin],
    define: {
      __APPLICATION_VERSION__: JSON.stringify(applicationVersion),
    },
    banner: {
      // Provide a CommonJS `require` shim so transitive CJS dependencies inside
      // bundled ESM output (such as `bcryptjs` or `ttag`) can resolve built-ins.
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as createNodeModuleRequire } from 'node:module';",
        'const require = createNodeModuleRequire(import.meta.url);',
      ].join('\n'),
    },
  });

  await fs.chmod(outputFilePath, 0o755);
}

buildApplicationBundle().catch((buildError) => {
  const errorMessage = buildError instanceof Error ? buildError.message : String(buildError);
  console.error(`Build failed: ${errorMessage}`);
  process.exit(1);
});
