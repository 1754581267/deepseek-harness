/**
 * Build a self-contained runnable directory for the `dsh web` browser UI.
 *
 * The output is a symlink-free closure: `pnpm deploy` materializes the
 * `@deepseek-ai/dsh` app and its whole dependency graph under one flat
 * `node_modules`, every workspace link is replaced with a real copy, and the
 * launcher scripts run the entry with the system Node.js. The frontend dist
 * and the shipped agent presets ride inside the closure — `dsh-web-app`
 * depends on `dsh-web-frontend`, and `apps/cli` ships `config/` — so the
 * directory is fully self-contained: copy it to a machine with Node.js and run
 * `./dsh web`.
 *
 * Cross-platform note: the closure is built per platform. node-pty is pure JS
 * on Windows (the conpty `windowsTerminal` backend) and loads a native `.node`
 * addon on Linux/macOS, which rides along inside `node_modules`; build each
 * platform's artifact on that platform so the native binary matches.
 *
 * Reuses the deploy flags and symlink-materialization strategy of
 * build-exe-for-python-sdk.ts (the same pnpm deploy invocation and the same
 * findSymlink/materialize loop).
 * @module package-standalone
 */

import { spawn } from 'node:child_process'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** The repository root; scripts run from `scripts/`, so one level up. */
const root = resolve(import.meta.dirname, '..')

/** The workspace app deployed as the self-contained root. */
const DEPLOY_PACKAGE = '@deepseek-ai/dsh'

/**
 * The deployed entry, relative to the output directory. `pnpm deploy` places
 * the deployed package (`@deepseek-ai/dsh`) at the output root, not under
 * `node_modules`, so the CLI lives at `lib/bin.js`.
 */
const ENTRY_BIN = 'lib/bin.js'

/** The default output directory, relative to the repository root. */
const DEFAULT_OUT = join('dist-standalone', 'dsh')

/** Node.js requirement, mirroring the root package.json `engines`. */
const NODE_REQUIREMENT = '^22.19.0 || >=24.0.0'

/** The pnpm deploy invocation's own diagnostics prefix. */
const NAME = 'package-standalone'

/** The pnpm executable name for the current platform (`pnpm.cmd` on Windows). */
function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

/**
 * The closure paths whose absence means the deploy omitted a required asset.
 * Each maps a human-readable label to a package-relative path. `dsh-web-app`
 * resolves the frontend dist through `require.resolve` at runtime, so the
 * dist must be present even though nothing imports it statically.
 */
const REQUIRED_PATHS: ReadonlyArray<{ label: string; path: string }> = [
  { label: 'dsh CLI entry', path: ENTRY_BIN },
  { label: 'shipped standard agent preset', path: 'config/agent-presets/standard/agent.cordis.yml' },
  { label: 'base bundle patch layer', path: 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml' },
  { label: 'web-app bundle patch layer', path: 'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml' },
  { label: 'browser frontend dist', path: 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html' },
  { label: 'node-pty terminal backend', path: 'node_modules/node-pty/lib/index.js' },
  { label: 'vendored cosmokit', path: 'node_modules/@deepseek-ai/cosmokit/lib/index.js' },
  { label: 'vendored schemastery', path: 'node_modules/@deepseek-ai/schemastery/lib/index.cjs' },
]

/** Resolved command-line options for one packaging run. */
interface StandaloneOptions {
  /** Output directory; the closure is deployed here. */
  out: string
  /** Skip `pnpm run build`; the current artifacts are reused as-is. */
  skipBuild: boolean
  /** Skip the end-to-end launch smoke test. */
  skipSmoke: boolean
}

/**
 * Parse the script's arguments.
 * @param argv - arguments after the Node binary and script.
 * @returns the resolved options.
 */
export function parseStandaloneArgs(argv: readonly string[]): StandaloneOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string', default: DEFAULT_OUT },
      'skip-build': { type: 'boolean', default: false },
      'skip-smoke': { type: 'boolean', default: false },
    },
  })
  // `default:` above makes each option non-optional; parseArgs types them as
  // optional, so the indexed reads carry no runtime nullish fallback.
  return { out: values.out, skipBuild: values['skip-build'], skipSmoke: values['skip-smoke'] }
}

/**
 * Spawn `command` with `args`, routing `.cmd`/`.bat` wrappers through cmd.exe
 * on Windows (which has no direct batch-executable) with verbatim arguments so
 * nothing is shell-interpolated. Arguments with spaces are quoted for the
 * concatenated command line.
 * @param command - the executable.
 * @param args - its arguments.
 * @param cwd - the working directory for the child.
 */
function spawnExecutable(command: string, args: string[], cwd: string): ReturnType<typeof spawn> {
  const env = { ...process.env, CI: 'true' }
  if (process.platform !== 'win32') {
    return spawn(command, args, { cwd, stdio: 'inherit', env })
  }
  const joined = [command, ...args].map(part => part.includes(' ') ? `"${part}"` : part).join(' ')
  return spawn('cmd.exe', ['/d', '/s', '/c', joined], {
    cwd,
    stdio: 'inherit',
    windowsVerbatimArguments: true,
    env,
  })
}

/**
 * Run one subprocess with inherited stdio. Non-zero exits reject with the
 * command and exit code, matching the diagnostics of build-exe-for-python-sdk.
 * @param label - the step name used in logs and error messages.
 * @param command - the executable.
 * @param args - its arguments.
 */
async function run(label: string, command: string, args: string[], cwd: string): Promise<void> {
  const printable = [command, ...args].join(' ')
  console.log(`${NAME}: ${label}: ${printable}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawnExecutable(command, args, cwd)
    child.once('error', (error) => {
      reject(new Error(`${NAME}: ${label} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`${NAME}: ${label} failed (${cause}): ${printable}`))
    })
  })
}

/** Build all package artifacts (`lib/` and the frontend dist). */
async function build(): Promise<void> {
  await run('build', pnpmBin(), ['run', 'build'], root)
}

/**
 * Deploy the app and its dependency closure into the output directory. The
 * hoisted linker and `--legacy` mirror build-exe-for-python-sdk's verified
 * invocation: one flat `node_modules` under the output, workspace packages
 * linked (later materialized), everything else real directories.
 * @param out - the output directory.
 */
async function deploy(out: string): Promise<void> {
  if (out === root || root.startsWith(out + sep)) {
    throw new Error(`${NAME}: refusing to deploy into ${out}: it contains the repository root.`)
  }
  await rm(out, { recursive: true, force: true })
  await run(
    'deploy',
    pnpmBin(),
    [
      '--filter', DEPLOY_PACKAGE,
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      out,
    ],
    root,
  )
}

/**
 * Replace every symbolic link below `directory` with a real copy of its
 * target, recursing until no link remains. Workspace links are deployed as
 * junctions/symlinks by pnpm; a self-contained directory must be free of them.
 * @param directory - the root to scan (the output directory).
 */
export async function materializeLinks(directory: string): Promise<void> {
  const remaining = await findSymlink(directory)
  if (remaining === undefined) return
  // Segments are relative to the scan root, so the `.bin` detection does not
  // depend on where `node_modules` sits under it.
  const segments = remaining.slice(directory.length + 1).split(sep)
  const binIndex = segments.lastIndexOf('.bin')
  if (binIndex >= 0) {
    await rm(join(directory, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
    await materializeLinks(directory)
    return
  }
  const source = await realpath(remaining)
  const nestedNodeModules = join(source, 'node_modules')
  await rm(remaining, { recursive: true, force: true })
  await cp(source, remaining, {
    recursive: true,
    dereference: true,
    filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
  })
  await materializeLinks(directory)
}

/** Return the first symbolic link below a directory, if one exists. */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** One workspace package: its name and repository directory. */
interface WorkspacePackage {
  name: string
  dir: string
}

/**
 * Index every workspace package by name, resolving each manifest. Mirrors the
 * workspace globs of verify-runtime-closure.ts.
 * @param repoRoot - the repository root to scan.
 * @returns package name → workspace package.
 */
export function loadWorkspaceIndex(repoRoot: string): Map<string, WorkspacePackage> {
  const index = new Map<string, WorkspacePackage>()
  for (const pattern of ['packages/*/*/package.json', 'vendor/*/package.json']) {
    for (const relative of globSync(pattern, { cwd: repoRoot })) {
      const manifestPath = resolve(repoRoot, relative)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
      if (manifest.name !== undefined) {
        index.set(manifest.name, { name: manifest.name, dir: dirname(manifestPath) })
      }
    }
  }
  return index
}

/**
 * The workspace packages the deploy root reaches through dependencies and
 * peers, transitively — the packages the product must carry. Peer dependencies
 * participate because Cordis Service Definition packages (`dsh-subprocess`,
 * `dsh-compaction`, …) are peers of their implementations yet imported
 * directly by the plugin tree.
 * @param manifest - the deploy root manifest.
 * @param index - the workspace package index.
 * @returns package name → workspace package.
 */
export function workspaceDependencyClosure(
  manifest: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> },
  index: Map<string, WorkspacePackage>,
): Map<string, WorkspacePackage> {
  const closure = new Map<string, WorkspacePackage>()
  const queue = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (closure.has(next)) continue
    const workspace = index.get(next)
    if (workspace === undefined) continue
    closure.set(next, workspace)
    const nested = JSON.parse(readFileSync(join(workspace.dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    queue.push(...Object.keys(nested.dependencies ?? {}), ...Object.keys(nested.peerDependencies ?? {}))
  }
  return closure
}

/**
 * Restore workspace packages the deploy omitted from the closure. pnpm deploy
 * materializes only the deploy root's own dependency tree; workspace packages
 * reached transitively or as peers — `cordis-plugin-group` as a peer of
 * `dsh-app-boot`, the `link:`-override vendored packages, and every Cordis
 * Service Definition peer — are recorded but never copied in. Copy each
 * workspace package in the root's dependency closure that the product is
 * missing, excluding nested `node_modules` so the flat closure stays
 * authoritative.
 * @param out - the output directory holding the deployed closure.
 * @param repoRoot - the repository root to resolve workspace packages from;
 * defaults to this module's root (the tests inject a temporary one).
 */
export async function restoreWorkspaceClosure(out: string, repoRoot: string = root): Promise<void> {
  const index = loadWorkspaceIndex(repoRoot)
  const appManifest = JSON.parse(readFileSync(join(repoRoot, 'apps', 'cli', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  const restored: string[] = []
  for (const workspace of workspaceDependencyClosure(appManifest, index).values()) {
    const destination = join(out, 'node_modules', workspace.name)
    if (existsSync(destination)) continue
    const nestedNodeModules = join(workspace.dir, 'node_modules')
    await mkdir(dirname(destination), { recursive: true })
    await cp(workspace.dir, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    restored.push(workspace.name)
  }
  if (restored.length > 0) {
    console.log(`${NAME}: restored omitted workspace packages: ${restored.join(', ')}`)
  }
}

/** The two launcher texts, derived pure so tests can assert them. */
export function launcherContents(): { posix: string; windows: string } {
  const posix = [
    '#!/usr/bin/env sh',
    `# DeepSeek Harness self-contained launcher. Requires Node.js ${NODE_REQUIREMENT}.`,
    'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'exec node "$SCRIPT_DIR/lib/bin.js" "$@"',
    '',
  ].join('\n')
  const windows = [
    '@echo off',
    `rem DeepSeek Harness self-contained launcher. Requires Node.js ${NODE_REQUIREMENT}.`,
    'node "%~dp0lib\\bin.js" %*',
    '',
  ].join('\r\n')
  return { posix, windows }
}

/**
 * Write the platform launchers at the output root. The POSIX one is
 * executable; the `.cmd` one serves Windows. Both simply hand the arguments to
 * the deployed entry through the system Node.js.
 * @param out - the output directory.
 */
async function writeLaunchers(out: string): Promise<void> {
  const { posix, windows } = launcherContents()
  await writeFile(join(out, 'dsh'), posix)
  await chmod(join(out, 'dsh'), 0o755)
  await writeFile(join(out, 'dsh.cmd'), windows)
}

/**
 * Assert every required closure path exists, and that materialization left no
 * symbolic links behind. A missing asset fails the build loudly rather than
 * shipping a directory that breaks at runtime.
 * @param out - the output directory.
 */
export async function verifyClosure(out: string): Promise<void> {
  const missing = REQUIRED_PATHS.filter(({ path }) => !existsSync(join(out, path)))
  if (missing.length > 0) {
    throw new Error(
      `${NAME}: deployed closure is missing required paths: ${missing.map(({ label, path }) => `${label} (${path})`).join(', ')}`,
    )
  }
  const remaining = await findSymlink(join(out, 'node_modules'))
  if (remaining !== undefined) {
    throw new Error(`${NAME}: materialization left a symbolic link behind: ${remaining}`)
  }
  console.log(`${NAME}: closure verified: ${REQUIRED_PATHS.length} required paths present, no symbolic links.`)
}

/**
 * End-to-end smoke: launch `dsh web` from the output with an isolated
 * temporary home, wait for the HTTP server, and verify the boot manifest. This
 * proves the directory is self-contained and the entry boots.
 * @param out - the output directory.
 * @param skipBuild - whether artifacts were freshly built (affects nothing here).
 */
export async function smoke(out: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-standalone-home-'))
  const port = 30_000 + Math.floor(Math.random() * 20_000)
  const child = spawn(process.execPath, [ENTRY_BIN, 'web', '--port', String(port)], {
    cwd: out,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  try {
    const url = `http://127.0.0.1:${port}/`
    const deadline = Date.now() + 60_000
    let page = ''
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`${NAME}: smoke: server did not become ready on ${url}; stderr: ${stderr.slice(0, 500)}`)
      }
      try {
        const response = await fetch(url)
        if (response.ok) {
          page = await response.text()
          break
        }
      } catch {
        // Server not up yet; retry.
      }
      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 500))
    }
    // The boot manifest is injected as `window.__DSH_BOOT__` (older builds) or
    // `globalThis["__DSH_BOOT__"]` (current builds); the bare token covers both.
    if (!page.includes('__DSH_BOOT__')) {
      throw new Error(`${NAME}: smoke: served page is missing the __DSH_BOOT__ boot manifest`)
    }
    console.log(`${NAME}: smoke: ${url} served the boot manifest successfully.`)
  } finally {
    child.kill()
    // The exit event can already have fired before the listener attaches; the
    // code/signal fields are the reliable liveness check, with a timeout so a
    // stubborn process never hangs the packaging run.
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit()
        return
      }
      child.once('exit', () => { resolveExit() })
      setTimeout(() => { resolveExit() }, 5000).unref()
    })
    await rm(home, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const options = parseStandaloneArgs(process.argv.slice(2))
  const out = resolve(root, options.out)
  console.log(`${NAME}: output: ${out}`)
  if (!options.skipBuild) await build()
  await deploy(out)
  await materializeLinks(out)
  await restoreWorkspaceClosure(out)
  await writeLaunchers(out)
  await verifyClosure(out)
  if (!options.skipSmoke) await smoke(out)
  console.log(`${NAME}: done: run ${join(out, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')} web`)
}

// Run only as a script, not when imported by the spec (whose top-level import
// must not trigger a full packaging run).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
