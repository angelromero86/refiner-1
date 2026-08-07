/**
 * Every git interaction refiner performs. All of it shells out to the `git`
 * binary with argv arrays (never a shell string), so paths with spaces or
 * quotes need no escaping.
 */

/**
 * Porcelain status letters, plus `' '` for "this file has no changes" — which only
 * occurs in ALL mode, where the tree lists the whole repo rather than just the diff.
 */
export type Status = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T' | '?' | ' '

/** True when the file actually differs from HEAD (or from the review target). */
export function isChanged(f: ChangedFile): boolean {
  return f.status !== ' '
}

export interface ChangedFile {
  path: string
  status: Status
  oldPath: string
  /**
   * Raw porcelain XY: indexCode (X) is the index-vs-HEAD status, workCode (Y)
   * is the working-tree-vs-index status. ' ' means clean on that side.
   */
  indexCode: string
  workCode: string
}

/**
 * fullyStaged reports whether every change to the file is already in git's
 * index — equivalent to "Y is clean" in porcelain. Untracked files (X='?')
 * don't count as staged until they've been `git add`-ed.
 */
export function fullyStaged(f: ChangedFile): boolean {
  return f.indexCode !== ' ' && f.indexCode !== '?' && (f.workCode === ' ' || f.workCode === '')
}

export enum Mode {
  Uncommitted,
  Review,
}

export interface Source {
  mode: Mode
  target: string
}

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function run(args: string[], stdin?: string): Promise<RunResult> {
  const proc = Bun.spawn(['git', ...args], {
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

/**
 * loadAllFiles lists every file in the repo, carrying the change status of the ones
 * that have it.
 *
 * `ls-files --cached --others --exclude-standard` is tracked plus untracked, minus
 * anything .gitignore excludes — so no node_modules, no build output. Files that are
 * only in the change set (a deletion already staged, say) are appended, because
 * ls-files no longer knows about them.
 */
export async function loadAllFiles(source: Source): Promise<ChangedFile[]> {
  const changed = await loadChangedFiles(source)
  const byPath = new Map(changed.map((f) => [f.path, f]))

  const r = await run(['ls-files', '--cached', '--others', '--exclude-standard'])
  if (r.exitCode !== 0) throw new Error(`git ls-files: ${r.stderr.trim()}`)

  const out: ChangedFile[] = []
  const seen = new Set<string>()
  for (const path of r.stdout.split('\n')) {
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    out.push(
      byPath.get(path) ?? { path, status: ' ', oldPath: '', indexCode: ' ', workCode: ' ' },
    )
  }
  for (const f of changed) {
    if (!seen.has(f.path)) out.push(f)
  }
  return out
}

export async function loadChangedFiles(source: Source): Promise<ChangedFile[]> {
  if (source.mode === Mode.Uncommitted) {
    const r = await run(['status', '--porcelain=v1', '--untracked-files=all'])
    if (r.exitCode !== 0) throw new Error(`git status: ${r.stderr.trim()}`)
    return parsePorcelain(r.stdout)
  }
  const r = await run(['diff', '--name-status', `${source.target}...HEAD`])
  if (r.exitCode !== 0) throw new Error(`git diff --name-status: ${r.stderr.trim()}`)
  return parseNameStatus(r.stdout)
}

export function parsePorcelain(out: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const line of out.split('\n')) {
    if (line.length < 3) continue
    const xy = line.slice(0, 2)
    const rest = line.slice(3)
    const indexCode = xy[0]
    const treeCode = xy[1]

    if (xy === '??') {
      files.push({ status: '?', path: rest, oldPath: '', indexCode, workCode: treeCode })
      continue
    }
    const code = treeCode !== ' ' ? treeCode : indexCode
    const status = normalizeStatus(code)
    if (status === 'R' || status === 'C') {
      const parts = splitN(rest, ' -> ', 2)
      if (parts.length === 2) {
        files.push({
          status,
          oldPath: parts[0],
          path: parts[1],
          indexCode,
          workCode: treeCode,
        })
        continue
      }
    }
    files.push({ status, path: rest, oldPath: '', indexCode, workCode: treeCode })
  }
  return files
}

export function parseNameStatus(out: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const line of out.split('\n')) {
    if (line === '') continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const code = parts[0]
    if (code === '') continue
    const status = normalizeStatus(code[0])
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      files.push({ status, oldPath: parts[1], path: parts[2], indexCode: '', workCode: '' })
    } else {
      files.push({ status, path: parts[1], oldPath: '', indexCode: '', workCode: '' })
    }
  }
  return files
}

function normalizeStatus(b: string): Status {
  switch (b) {
    case 'M':
    case 'A':
    case 'D':
    case 'R':
    case 'C':
    case 'U':
    case 'T':
    case '?':
      return b
    default:
      return 'M'
  }
}

/** StageFile runs `git add <path>` — full-file staging from the tree. */
export async function stageFile(path: string): Promise<void> {
  const r = await run(['add', '--', path])
  if (r.exitCode !== 0) {
    throw new Error(`git add ${path}: ${(r.stderr + r.stdout).trim()}`)
  }
}

/**
 * unstageFile runs `git restore --staged <path>`, falling back to
 * `git reset HEAD` for older git versions. Reverts all staged changes.
 */
export async function unstageFile(path: string): Promise<void> {
  const r = await run(['restore', '--staged', '--', path])
  if (r.exitCode === 0) return
  const r2 = await run(['reset', 'HEAD', '--', path])
  if (r2.exitCode !== 0) {
    throw new Error(
      `git restore/reset ${path}: ${(r.stderr + r.stdout).trim()} / ${(r2.stderr + r2.stdout).trim()}`,
    )
  }
}

/**
 * loadStagedDiff returns the index-vs-HEAD diff for a file (whole-file context
 * via -U99999). Empty result when there are no staged changes, in review mode,
 * or for untracked files (nothing in the index unless added).
 */
export async function loadStagedDiff(source: Source, file: ChangedFile): Promise<string> {
  if (source.mode !== Mode.Uncommitted) return ''
  const r = await run(['diff', '--no-color', '-U99999', '--cached', 'HEAD', '--', file.path])
  if (r.exitCode === 0 || r.exitCode === 1) return r.stdout
  // File not in index (e.g. untracked + not added): treat as empty.
  return ''
}

/** applyPatchToIndex pipes a unified-diff patch into `git apply --cached`. */
export async function applyPatchToIndex(patch: string): Promise<void> {
  const r = await run(['apply', '--cached', '--whitespace=nowarn'], patch)
  if (r.exitCode !== 0) {
    throw new Error(`git apply --cached: ${(r.stderr + r.stdout).trim()}`)
  }
}

export async function loadDiff(source: Source, file: ChangedFile): Promise<string> {
  // -U99999 gives the whole file as a unified diff so we can show the entire
  // file content with the changes highlighted in place.
  let args: string[]
  if (source.mode === Mode.Uncommitted && file.status === '?') {
    args = ['diff', '--no-index', '--no-color', '-U99999', '--', '/dev/null', file.path]
  } else if (source.mode === Mode.Uncommitted) {
    args = ['diff', '--no-color', '-U99999', 'HEAD', '--', file.path]
  } else {
    args = ['diff', '--no-color', '-U99999', `${source.target}...HEAD`, '--', file.path]
  }
  const r = await run(args)
  if (r.exitCode === 0) return r.stdout
  // `--no-index` exits 1 whenever the two files differ, which is the normal
  // case for an untracked file. Everywhere else a non-zero exit is a real
  // failure, so don't widen this.
  if (r.exitCode === 1 && file.status === '?') return r.stdout
  throw new Error(`git diff: ${r.stderr.trim()}`)
}

/** repoRoot returns the absolute path of the current repo's top level. */
export async function repoRoot(): Promise<string> {
  const r = await run(['rev-parse', '--show-toplevel'])
  if (r.exitCode !== 0) throw new Error(`git rev-parse: ${r.stderr.trim()}`)
  const root = r.stdout.trim()
  if (root === '') throw new Error('not inside a git repo')
  return root
}

/** repoName returns the basename of the repo root, or "" if not in a repo. */
export async function repoName(): Promise<string> {
  try {
    const root = await repoRoot()
    const i = root.lastIndexOf('/')
    return i >= 0 ? root.slice(i + 1) : root
  } catch {
    return ''
  }
}

/** gitUserName returns `git config user.name`, or "" when unset. */
export async function gitUserName(): Promise<string> {
  const r = await run(['config', 'user.name'])
  if (r.exitCode !== 0) return ''
  return r.stdout.trim()
}

/** Go's strings.SplitN(s, sep, 2). */
function splitN(s: string, sep: string, n: number): string[] {
  if (n !== 2) throw new Error('splitN only implements n=2')
  const i = s.indexOf(sep)
  if (i < 0) return [s]
  return [s.slice(0, i), s.slice(i + sep.length)]
}
