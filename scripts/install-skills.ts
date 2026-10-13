#!/usr/bin/env bun
/**
 * Installs refiner's Claude Code skills by symlinking them into a skills directory.
 *
 * Symlinks rather than copies: the skills live in this repo, so a `git pull` updates
 * what Claude Code sees without re-running anything.
 *
 *   bun run install-skills              → ~/.claude/skills (every project)
 *   bun run install-skills --project    → ./.claude/skills (the current repo only)
 *   bun run install-skills --project ../other-repo
 *   bun run install-skills --uninstall  → removes them again
 *   bun run install-skills --force      → replace a conflicting link
 *
 * It never overwrites anything it did not create. A real directory, or a symlink
 * pointing somewhere else, is reported and skipped — clobbering a skill someone
 * wrote themselves would be a far worse outcome than an install that didn't finish.
 */

import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const SKILLS = ['refine-review', 'refine-resolve', 'refine-web'] as const

const repoRoot = resolve(import.meta.dir, '..')
const sourceDir = join(repoRoot, 'skills')

interface Options {
  target: string
  scope: string
  uninstall: boolean
  force: boolean
}

function parseArgs(argv: string[]): Options {
  const uninstall = argv.includes('--uninstall')
  const force = argv.includes('--force')
  const i = argv.indexOf('--project')

  if (i < 0) {
    return { target: join(homedir(), '.claude', 'skills'), scope: 'global', uninstall, force }
  }
  // `--project` on its own means "here"; `--project <path>` means that repo.
  const next = argv[i + 1]
  const base = next && !next.startsWith('--') ? next : process.cwd()
  const abs = isAbsolute(base) ? base : resolve(process.cwd(), base)
  return { target: join(abs, '.claude', 'skills'), scope: `project (${abs})`, uninstall, force }
}

/** What is at `path`: our link, someone else's link, a real file, or nothing. */
async function inspect(
  path: string,
  want: string,
): Promise<'ours' | 'other-link' | 'real' | 'absent'> {
  try {
    const st = await lstat(path)
    if (!st.isSymbolicLink()) return 'real'
    return resolve(await readlink(path)) === want ? 'ours' : 'other-link'
  } catch {
    return 'absent'
  }
}

const opts = parseArgs(process.argv.slice(2))
let failed = 0

console.log(`refiner skills → ${opts.target}  [${opts.scope}]\n`)

if (!opts.uninstall) await mkdir(opts.target, { recursive: true })

for (const name of SKILLS) {
  const from = join(sourceDir, name)
  const to = join(opts.target, name)
  const state = await inspect(to, from)

  if (opts.uninstall) {
    // Only ever remove our own link, so an unrelated skill of the same name lives.
    if (state === 'ours') {
      await unlink(to)
      console.log(`  removed  ${name}`)
    } else if (state === 'absent') {
      console.log(`  –        ${name} (not installed)`)
    } else {
      console.log(`  skipped  ${name} — not our symlink, leaving it alone`)
    }
    continue
  }

  if (state === 'ours') {
    console.log(`  ok       ${name} (already installed)`)
    continue
  }
  if (state === 'real') {
    // Deliberately not covered by --force. This is a directory somebody authored;
    // removing it recursively on the strength of a flag is not a trade this script
    // gets to make. Moving it aside is one command and they keep their work.
    console.error(`  CONFLICT ${name} — a real directory already exists at ${to}`)
    console.error(`           move it aside yourself, then re-run`)
    failed++
    continue
  }
  if (state === 'other-link') {
    if (!opts.force) {
      console.error(`  CONFLICT ${name} — a symlink to somewhere else exists at ${to}`)
      console.error(`           → ${await readlink(to)}`)
      console.error(`           re-run with --force to repoint it here`)
      failed++
      continue
    }
    await unlink(to)
  }
  await symlink(from, to)
  console.log(`  linked   ${name}`)
}

if (!opts.uninstall) {
  console.log(`
Restart Claude Code (or start a new session) to pick them up, then:
  /refine-review    review the diff and leave threads in .refiner/comments.json
  /refine-resolve   read the open threads, apply the changes, reply in-thread`)
}

if (failed > 0) process.exit(1)
