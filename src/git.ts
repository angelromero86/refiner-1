/**
 * Every git interaction refiner performs. All of it shells out to the `git`
 * binary with argv arrays (never a shell string), so paths with spaces or
 * quotes need no escaping.
 *
 * Everything here assumes the process cwd IS the repo root. `git status
 * --porcelain` reports root-relative paths, but pathspecs (`diff -- <p>`,
 * `add -- <p>`), `--no-index` filesystem paths and the headers inside the patch
 * fed to `git apply --cached` all resolve against the cwd — so from anywhere
 * else the two path spaces disagree and git quietly does nothing. `main()` calls
 * `enterRepoRoot()` before touching the repo; anything else that drives this
 * module (tests, scripts) has to do the same.
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

/**
 * hasUnstagedChanges reports whether part of the file is still outside the index
 * — "Y is dirty" in porcelain, which covers an untracked file (`??`) as well.
 *
 * It is NOT the negation of `fullyStaged`: an UNCHANGED file (ALL mode's `'  '`)
 * is neither, and conflating the two is what made every folder in the repo read
 * as work outstanding.
 */
export function hasUnstagedChanges(f: ChangedFile): boolean {
  return f.workCode !== ' ' && f.workCode !== ''
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
 *
 * This is the only call that PRODUCES paths rather than consuming them, so it is
 * pinned to the root explicitly rather than relying on the cwd invariant alone: a
 * path produced here becomes a key in `app.cache`/`app.staged`, a `file` in
 * `.refiner/comments.json` and a header in the patch git applies. `--full-name`
 * fixes the format (cwd-relative → root-relative) and `:/` fixes the scope
 * (ls-files otherwise lists only the cwd's subtree); neither alone is enough. From
 * the root the output is unchanged.
 */
export async function loadAllFiles(source: Source): Promise<ChangedFile[]> {
  const changed = await loadChangedFiles(source)
  const byPath = new Map(changed.map((f) => [f.path, f]))

  const r = await run([
    'ls-files',
    '--full-name',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    ':/',
  ])
  if (r.exitCode !== 0) throw new Error(`git ls-files: ${r.stderr.trim()}`)

  const out: ChangedFile[] = []
  const seen = new Set<string>()
  for (const path of r.stdout.split('\n')) {
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    out.push(byPath.get(path) ?? { path, status: ' ', indexCode: ' ', workCode: ' ' })
  }
  for (const f of changed) {
    if (!seen.has(f.path)) out.push(f)
  }
  return out
}

/**
 * `--no-renames` is load-bearing in BOTH branches, and they have to stay in step.
 *
 * A rename is one change over two paths, and every other path space in refiner
 * assumes a `ChangedFile` is exactly one path: the tree splits `path` on `/`, the
 * diff cache and `app.staged` key on it, `stageFile`/`unstageFile` pass it as a
 * pathspec and `buildPartialPatch` writes it into the patch header. Asking git to
 * report renames as delete+add makes that assumption true for every entry instead
 * of true-except-for-renames.
 *
 * Without the flag, porcelain reports `R  old -> new`, and the moment the working
 * tree touches the file after the rename it becomes `RM old -> new`, where the
 * status letter picked below is `M` — so the two-path branch is not even taken and
 * `path` becomes the literal string `"old -> new"`. That string is then used as a
 * pathspec everywhere: the diff comes back empty with exit 0 (blank panel),
 * `git add` fails with `fatal: pathspec ...`, and `git restore --staged` fails but
 * the `git reset` fallback in `unstageFile` exits 0 having done nothing, so
 * unstaging is silent. `tree.build` also invents a `src/a.ts -> src` directory out
 * of it.
 *
 * Nothing is lost in the panel: `loadDiff` restricts the diff with a single-path
 * pathspec, so git only ever sees one side of the pair and already renders the new
 * side as a whole-file creation. Showing `rename from`/`rename to` would mean
 * passing both paths and teaching `src/diff.ts` to emit those headers — see
 * `docs/bugs/07`. What the split does add is the `D` row for the old side, which
 * the reviewer never used to see at all.
 *
 * Changing only one branch would leave the two-path model alive in the half that
 * wasn't migrated: review mode goes through `parseNameStatus`, uncommitted mode
 * through `parsePorcelain`.
 */
export async function loadChangedFiles(source: Source): Promise<ChangedFile[]> {
  if (source.mode === Mode.Uncommitted) {
    const r = await run(['status', '--porcelain=v1', '--untracked-files=all', '--no-renames'])
    if (r.exitCode !== 0) throw new Error(`git status: ${r.stderr.trim()}`)
    return parsePorcelain(r.stdout)
  }
  const r = await run(['diff', '--name-status', '--no-renames', `${source.target}...HEAD`])
  if (r.exitCode !== 0) throw new Error(`git diff --name-status: ${r.stderr.trim()}`)
  return parseNameStatus(r.stdout)
}

/**
 * One line is one `<XY> <path>`. Renames used to need a second path here; they
 * don't any more because `loadChangedFiles` passes `--no-renames`, so ` -> ` can
 * no longer appear in a status line and a path containing it is a real filename.
 */
export function parsePorcelain(out: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const line of out.split('\n')) {
    if (line.length < 3) continue
    const xy = line.slice(0, 2)
    const rest = line.slice(3)
    const indexCode = xy[0]
    const treeCode = xy[1]

    if (xy === '??') {
      files.push({ status: '?', path: rest, indexCode, workCode: treeCode })
      continue
    }
    const code = treeCode !== ' ' ? treeCode : indexCode
    files.push({ status: normalizeStatus(code), path: rest, indexCode, workCode: treeCode })
  }
  return files
}

/** One line is one `<code>\t<path>` — see `parsePorcelain` on why never three columns. */
export function parseNameStatus(out: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const line of out.split('\n')) {
    if (line === '') continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const code = parts[0]
    if (code === '') continue
    files.push({ status: normalizeStatus(code[0]), path: parts[1], indexCode: '', workCode: '' })
  }
  return files
}

/**
 * `R`/`C` stay in the type and here because they cost nothing and keep the door
 * open for a rename-aware view; with `--no-renames` on both queries no parser can
 * emit them today. Same for the `case 'R'` badge colour in `src/styles.ts`.
 */
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
 *
 * Careful with the fallback: unlike `restore`, `git reset` treats a pathspec that
 * matches nothing as success — it exits 0 having done nothing at all. So a zero
 * exit here means "git had no complaint", not "the file is unstaged". That is what
 * made staging from a subdirectory fail silently, and it is why `path` must be
 * root-relative with the process sitting at the root.
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
  if (r.exitCode === 1 && file.status === '?') {
    // ...but exit 1 also covers "Could not access <path>", and swallowing that
    // turns an unreadable path into an empty panel with no error. A genuine
    // difference always prints at least the `diff --git` header, even for an
    // empty new file, so an empty stdout plus a complaint on stderr is a failure.
    if (r.stdout === '' && r.stderr.trim() !== '') throw new Error(`git diff: ${r.stderr.trim()}`)
    return r.stdout
  }
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

/**
 * enterRepoRoot moves the process to the repo root and returns it.
 *
 * For refiner, `process.cwd()` carries no meaning: the store lives at the root,
 * the watcher watches the root, `ChangedFile.path` and `StoredThread.file` are
 * root-relative, and so are the headers of the patch `git apply --cached` eats.
 * Launched from a subdirectory none of that lines up with git's cwd-relative
 * pathspecs, and git's answer to a pathspec that matches nothing is usually exit
 * 0 with no output — an empty diff and an unchanged index, with no error anywhere.
 * Making the cwd the root makes all four path spaces agree at once.
 *
 * Call it once, at startup, before anything else touches the repo. It lives here
 * rather than in `index.ts` because `index.ts` invokes `main()` at module scope,
 * so nothing can import from it without launching the TUI.
 *
 * Outside a repo it throws whatever `repoRoot()` throws (`git rev-parse: fatal:
 * not a git repository …`), which is where refiner should stop rather than start
 * up half-working.
 */
export async function enterRepoRoot(): Promise<string> {
  const root = await repoRoot()
  process.chdir(root)
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
