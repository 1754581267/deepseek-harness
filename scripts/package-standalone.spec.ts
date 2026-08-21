import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launcherContents, materializeLinks, parseStandaloneArgs, restoreWorkspaceClosure, verifyClosure } from './package-standalone.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('parseStandaloneArgs', () => {
  it('uses the default output and runs build plus smoke', () => {
    expect(parseStandaloneArgs([])).toEqual({ out: join('dist-standalone', 'dsh'), skipBuild: false, skipSmoke: false })
  })

  it('honors --out and both skip flags', () => {
    expect(parseStandaloneArgs(['--out', 'dist/my-dsh', '--skip-build', '--skip-smoke'])).toEqual({
      out: 'dist/my-dsh',
      skipBuild: true,
      skipSmoke: true,
    })
  })
})

describe('materializeLinks', () => {
  it('replaces a directory link with a real copy of its target', async () => {
    const root = temporaryRoot()
    const source = join(root, 'real-package')
    const linked = join(root, 'node_modules', '@deepseek-ai', 'linked-package')
    mkdirSync(join(source, 'lib'), { recursive: true })
    writeFileSync(join(source, 'lib', 'entry.js'), 'export default 42\n')
    writeFileSync(join(source, 'package.json'), '{}\n')
    mkdirSync(dirname(linked), { recursive: true })
    symlinkSync(source, linked, 'junction')

    await materializeLinks(join(root, 'node_modules'))

    expect(lstatSync(linked).isSymbolicLink()).toBe(false)
    expect(existsSync(join(linked, 'lib', 'entry.js'))).toBe(true)
  })

  it('removes a leftover .bin link without failing', async () => {
    const root = temporaryRoot()
    const bin = join(root, 'node_modules', '.bin')
    mkdirSync(join(root, 'real-bin'), { recursive: true })
    writeFileSync(join(root, 'real-bin', 'dsh'), '#!/usr/bin/env node\n')
    mkdirSync(bin, { recursive: true })
    symlinkSync(join(root, 'real-bin', 'dsh'), join(bin, 'dsh'), 'junction')

    await materializeLinks(join(root, 'node_modules'))

    expect(existsSync(join(root, 'node_modules', '.bin'))).toBe(false)
  })
})

describe('verifyClosure', () => {
  it('accepts a closure with every required path and no links', async () => {
    const root = temporaryRoot()
    createClosure(root)
    await expect(verifyClosure(root)).resolves.toBeUndefined()
  })

  it('rejects a closure missing a required path', async () => {
    const root = temporaryRoot()
    createClosure(root)
    rmSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'))
    await expect(verifyClosure(root)).rejects.toThrow(/missing required paths/)
  })

  it('rejects a closure that still holds a symbolic link', async () => {
    const root = temporaryRoot()
    createClosure(root)
    const source = join(root, 'real-target')
    mkdirSync(source, { recursive: true })
    symlinkSync(source, join(root, 'node_modules', 'still-linked'), 'junction')
    await expect(verifyClosure(root)).rejects.toThrow(/left a symbolic link behind/)
  })
})

describe('restoreWorkspaceClosure', () => {
  it('copies transitive and peer workspace packages the deploy omitted', async () => {
    const repoRoot = temporaryRoot()
    const out = join(repoRoot, 'out')
    writeWorkspacePackage(repoRoot, 'apps/cli/package.json', {
      name: '@deepseek-ai/dsh',
      dependencies: { '@deepseek-ai/dsh-app-boot': 'workspace:^' },
    })
    writeWorkspacePackage(repoRoot, 'packages/boot/app-boot/package.json', {
      name: '@deepseek-ai/dsh-app-boot',
      dependencies: { '@deepseek-ai/cosmokit': 'workspace:^' },
      peerDependencies: { '@deepseek-ai/cordis-plugin-group': 'workspace:^' },
    })
    writeWorkspacePackage(repoRoot, 'vendor/cosmokit/package.json', { name: '@deepseek-ai/cosmokit' })
    writeWorkspacePackage(repoRoot, 'packages/loader/group/package.json', { name: '@deepseek-ai/cordis-plugin-group' })

    await restoreWorkspaceClosure(out, repoRoot)

    expect(existsSync(join(out, 'node_modules', '@deepseek-ai', 'cosmokit', 'package.json'))).toBe(true)
    expect(existsSync(join(out, 'node_modules', '@deepseek-ai', 'cordis-plugin-group', 'package.json'))).toBe(true)
  })

  it('leaves a package alone when the closure already materialized it', async () => {
    const repoRoot = temporaryRoot()
    const out = join(repoRoot, 'out')
    writeWorkspacePackage(repoRoot, 'apps/cli/package.json', {
      name: '@deepseek-ai/dsh',
      dependencies: { '@deepseek-ai/cordis-plugin-group': 'workspace:^' },
    })
    writeWorkspacePackage(repoRoot, 'packages/loader/group/package.json', { name: '@deepseek-ai/cordis-plugin-group' })
    const existing = join(out, 'node_modules', '@deepseek-ai', 'cordis-plugin-group')
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, 'pre-existing'), 'kept\n')

    await restoreWorkspaceClosure(out, repoRoot)

    expect(existsSync(join(existing, 'pre-existing'))).toBe(true)
  })
})

function writeWorkspacePackage(repoRoot: string, relative: string, manifest: Record<string, unknown>): void {
  const path = join(repoRoot, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

describe('launcherContents', () => {
  it('posix launcher hands arguments to the deployed entry through node', () => {
    const { posix } = launcherContents()
    expect(posix).toContain('exec node "$SCRIPT_DIR/lib/bin.js" "$@"')
    expect(posix.startsWith('#!/usr/bin/env sh')).toBe(true)
  })

  it('windows launcher hands arguments to the deployed entry through node', () => {
    const { windows } = launcherContents()
    expect(windows).toContain('node "%~dp0lib\\bin.js" %*')
    expect(windows.startsWith('@echo off')).toBe(true)
  })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-standalone-'))
  roots.push(root)
  return root
}

/** Materialize every path REQUIRED_PATHS asserts, as real (non-link) files. */
function createClosure(root: string): void {
  const files = [
    'lib/bin.js',
    'config/agent-presets/standard/agent.cordis.yml',
    'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml',
    'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
    'node_modules/node-pty/lib/index.js',
    'node_modules/@deepseek-ai/cosmokit/lib/index.js',
    'node_modules/@deepseek-ai/schemastery/lib/index.cjs',
  ]
  for (const file of files) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
  }
}
