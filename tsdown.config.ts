import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  target: ['node22', 'chrome130', 'safari16'],
  skipNodeModulesBundle: true,
  exports: true,
})
