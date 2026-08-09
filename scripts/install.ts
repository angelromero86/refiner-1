#!/usr/bin/env bun
/**
 * Installs the compiled binary on this machine, sidecar included.
 *
 *   bun run install-local              → build, then install into ~/.local
 *   bun run install-local --no-build   → install whatever is already in dist/
 *   bun run install-local --prefix /opt/refiner
 *   bun run install-local --uninstall
 *   bun run install-local --force      → repoint a `refiner` link owned by someone else
 *
 * The layout is payload + link: the binary and `refiner-assets/` go together into
 * `<prefix>/share/refiner/`, and `<prefix>/bin/refiner` is a symlink to the binary.
 * That is not decoration. The sidecar has to sit next to the REAL executable — a
 * compiled Bun binary resolves `process.execPath` through symlinks to its real path
 * — so the link keeps ~130 MB out of the directory that is on everyone's PATH while
 * still letting `src/syntax.ts` find its parsers. Copying the binary alone into
 * `bin/` is the one shape that silently loses syntax highlighting, since a missing
 * sidecar never raises: it just renders every file uncolored.
 *
 * Two smaller rules the hard way. The assets directory is REPLACED rather than
 * copied over — `cp -R src dest/` onto an existing directory nests it inside itself
 * and leaves the previous build's files behind. And the binary is renamed into
 * place, not written over: overwriting an executable that is currently running
 * fails with ETXTBSY, and a reviewer upgrading refiner from inside refiner is not
 * an exotic scenario.
 */

import { existsSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, readlink, rename, rm, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { ASSET_DIR_NAME, PARSER_DIR_NAME, RUNTIME_ASSETS, VENDORED_FILETYPES } from '../src/syntax.ts'

const repoRoot = resolve(import.meta.dir, '..')
const distDir = join(repoRoot, 'dist')

interface Options {
  prefix: string
  build: boolean
  uninstall: boolean
  force: boolean
}

function parseArgs(argv: string[]): Options {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(`refiner installer

  bun run install-local              build, then install into ~/.local
  bun run install-local --no-build   install what is already in dist/
  bun run install-local --prefix DIR install into DIR/share and DIR/bin
  bun run install-local --uninstall  remove the binary, the sidecar and the link
  bun run install-local --force      repoint a \`refiner\` link owned by someone else
`)
    process.exit(0)
  }
  const i = argv.indexOf('--prefix')
  const given = i >= 0 ? argv[i + 1] : undefined
  if (i >= 0 && (!given || given.startsWith('--'))) {
    console.error('--prefix needs a directory')
    process.exit(1)
  }
  // XDG_DATA_HOME is the honest default for the payload, but the two halves have
  // to stay under one prefix for --prefix to mean anything, so ~/.local wins
  // unless the user says otherwise.
  const prefix = given ? (isAbsolute(given) ? given : resolve(process.cwd(), given)) : join(homedir(), '.local')
  return {
    prefix,
    build: !argv.includes('--no-build'),
    uninstall: argv.includes('--uninstall'),
    force: argv.includes('--force'),
  }
}

/** What is at `path`: our link, someone else's link, a real file, or nothing. */
async function inspect(path: string, want: string): Promise<'ours' | 'other-link' | 'real' | 'absent'> {
  try {
    const st = await lstat(path)
    if (!st.isSymbolicLink()) return 'real'
    return resolve(await readlink(path)) === want ? 'ours' : 'other-link'
  } catch {
    return 'absent'
  }
}

/**
 * Everything the sidecar must contain, as paths relative to it. The list is
 * derived from the same constants `src/syntax.ts` resolves at runtime, so a
 * grammar added there and forgotten in the build fails here rather than on the
 * user's screen — where it would look exactly like a file nobody colored.
 */
function sidecarContents(): string[] {
  return [...RUNTIME_ASSETS, ...VENDORED_FILETYPES.map((ft) => join(PARSER_DIR_NAME, ft, 'parser.wasm'))]
}

function assertComplete(assetsDir: string, what: string): void {
  // existsSync, not Bun.file().exists(): one of the entries is a directory, and
  // Bun.file() reports directories as absent.
  const missing = sidecarContents().filter((rel) => !existsSync(join(assetsDir, rel)))
  if (missing.length === 0) return
  console.error(`\n${what} is incomplete — syntax highlighting would be silently off:`)
  for (const rel of missing) console.error(`  missing  ${ASSET_DIR_NAME}/${rel}`)
  console.error(`\nRun \`bun run build\` again.`)
  process.exit(1)
}

const opts = parseArgs(process.argv.slice(2))
const libDir = join(opts.prefix, 'share', 'refiner')
const binDir = join(opts.prefix, 'bin')
const installedBinary = join(libDir, 'refiner')
const installedAssets = join(libDir, ASSET_DIR_NAME)
const link = join(binDir, 'refiner')

if (opts.uninstall) {
  console.log(`refiner ← ${libDir}\n`)
  const state = await inspect(link, installedBinary)
  if (state === 'ours') {
    await unlink(link)
    console.log(`  removed  ${link}`)
  } else if (state === 'absent') {
    console.log(`  –        ${link} (not installed)`)
  } else {
    // Same rule as install-skills: only ever remove what we put there.
    console.log(`  skipped  ${link} — not our symlink, leaving it alone`)
  }
  await rm(libDir, { recursive: true, force: true })
  console.log(`  removed  ${libDir}`)
  process.exit(0)
}

console.log(`refiner → ${libDir}\n         ${link}\n`)

if (opts.build) {
  const build = Bun.spawn(['bun', 'run', join(repoRoot, 'scripts/build.ts')], {
    cwd: repoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await build.exited) !== 0) process.exit(1)
} else if (!(await Bun.file(join(distDir, 'refiner')).exists())) {
  console.error(`No binary at dist/refiner. Drop --no-build, or run \`bun run build\` first.`)
  process.exit(1)
}

assertComplete(join(distDir, ASSET_DIR_NAME), `dist/${ASSET_DIR_NAME}`)

// Refuse before touching anything if the link is somebody else's, so a failed
// install doesn't leave a payload nothing points at.
const linkState = await inspect(link, installedBinary)
if (linkState === 'real') {
  console.error(`  CONFLICT ${link} already exists and is not a symlink`)
  console.error(`           move it aside yourself, then re-run`)
  process.exit(1)
}
if (linkState === 'other-link' && !opts.force) {
  console.error(`  CONFLICT ${link} is a symlink to somewhere else`)
  console.error(`           → ${await readlink(link)}`)
  console.error(`           re-run with --force to repoint it here`)
  process.exit(1)
}

await mkdir(libDir, { recursive: true })
await mkdir(binDir, { recursive: true })

// Replaced, never merged: a stale grammar left behind by the previous build is a
// file that loads fine and highlights wrong.
await rm(installedAssets, { recursive: true, force: true })
await cp(join(distDir, ASSET_DIR_NAME), installedAssets, { recursive: true })

// Rename over the old binary rather than writing through it — ETXTBSY if it is
// running, and a half-copied executable if it isn't.
const staged = join(libDir, 'refiner.new')
await cp(join(distDir, 'refiner'), staged)
await chmod(staged, 0o755)
await rename(staged, installedBinary)

assertComplete(installedAssets, libDir)

if (linkState === 'other-link') await unlink(link)
if (linkState !== 'ours') await symlink(installedBinary, link)

const size = (await Bun.file(installedBinary).stat()).size
console.log(`  binary   ${installedBinary}  (${(size / 1024 / 1024).toFixed(0)} MB)`)
console.log(`  assets   ${installedAssets}`)
console.log(`  link     ${link} → ${installedBinary}`)

// Run the installed copy THROUGH the link: that is the path the user's shell
// takes, and the only one that exercises execPath resolving back to the payload.
const smoke = Bun.spawn([link, '--help'], { cwd: homedir(), stdout: 'pipe', stderr: 'pipe' })
const [out, code] = [await new Response(smoke.stdout).text(), await smoke.exited]
if (code !== 0 || !out.startsWith('refiner')) {
  console.error(`\n  FAILED   \`${link} --help\` exited ${code}`)
  console.error(await new Response(smoke.stderr).text())
  process.exit(1)
}
console.log(`  verified refiner --help runs from the link`)

const onPath = (process.env['PATH'] ?? '').split(':').some((p) => p !== '' && resolve(p) === resolve(binDir))
if (!onPath) {
  console.log(`\n${binDir} is not on your PATH. Add it, e.g.:\n  echo 'export PATH="${binDir}:$PATH"' >> ~/.bashrc`)
}

console.log(`\nDone. Run \`refiner\` inside any git repo.`)
