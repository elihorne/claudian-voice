import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

const prod = process.argv[2] === 'production';

// Optional: OBSIDIAN_VAULT (env or .env.local) makes every build copy itself into that
// vault's plugin folder, so `npm run dev` keeps the installed plugin current.
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]+?)"?\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}
const vault = process.env.OBSIDIAN_VAULT;
const pluginDir = vault && existsSync(vault) ? path.join(vault, '.obsidian', 'plugins', 'claudian-voice') : null;

const copyToVault = {
  name: 'copy-to-vault',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length > 0 || !pluginDir) return;
      mkdirSync(pluginDir, { recursive: true });
      for (const file of ['main.js', 'manifest.json', 'styles.css']) {
        if (existsSync(file)) copyFileSync(file, path.join(pluginDir, file));
      }
      console.log(`[${new Date().toLocaleTimeString()}] copied to ${pluginDir}`);
    });
  },
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtinModules,
  ],
  format: 'cjs',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
  plugins: [copyToVault],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
  // styles.css is outside esbuild's module graph; copy it on its own when it changes.
  if (pluginDir) {
    const { watch } = await import('fs');
    watch('styles.css', () => {
      try {
        copyFileSync('styles.css', path.join(pluginDir, 'styles.css'));
        console.log(`[${new Date().toLocaleTimeString()}] copied styles.css`);
      } catch { /* mid-write; next event copies it */ }
    });
  }
}
