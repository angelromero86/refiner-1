# refiner

TUI de revisión de código para git. Inspirado en lazygit / GitHub diff, pensado para
trabajar codo a codo con agentes de IA (Claude Code, Cursor, etc.) sobre el mismo
fichero de threads — el mismo que usa la extensión **Refiner** de VSCode.

```
┌─ refiner · uncommitted · 3 archivos · 4 comentarios ─────────────────────┐
│ ▾ src/            M app.ts               ●           │  @@ -23,5 +23,8 @@│
│                   M view.ts                          │   function load…  │
│                   M render.ts            ●           │ + // Used to dec… │
│                                                      │ - if err != nil { │
│                                                      │ + return ts       │
│                                                      │ ...               │
└──────────────────────────────────────────────────────┴───────────────────┘
↑↓ navegar · → contenido · space stage · enter comment · c threads · q salir
```

Stack: Bun + [OpenTUI](https://opentui.com) (núcleo nativo en Zig). Port de
[eleview](https://github.com/ngromero86/eleview) (Go + bubbletea), por
[Angel Romero](https://github.com/ngromero86) con Claude Code.

## Características

- **Diff viewer** — tres vistas: unificada, split y "normal" (el archivo tal como
  queda después del cambio). Scroll fluido, sin re-render de todo el buffer.
- **Staging line-level** — `space` stagea/unstagea la línea o la selección bajo el
  cursor; parte el patch y se lo pasa a `git apply --cached`.
- **Threads de revisión** — anclados a `(file, start, end)`, persistidos en
  `.refiner/comments.json`. Editables a mano, por la extensión de VSCode o por un
  agente.
- **Minimapa** — banda de color por zona del archivo (comentario > staged > del >
  add) más el thumb del viewport, en la columna derecha del panel.
- **Fuzzy finder** — `p` abre un picker multi-término: `con task` encuentra
  `Controllers/Task.ts`.
- **Tema configurable** — paleta semántica en `~/.config/refiner/config.toml`.
- **Integración con tmux** — `e` abre nvim en el archivo, `g` abre lazygit, ambos en
  `display-popup` cuando hay sesión tmux.
- **Dos modos**:
  - `refiner` → cambios sin commitear (working tree + index)
  - `refiner <branch>` → review contra `<branch>...HEAD`

## Instalar

Requiere [Bun](https://bun.sh) 1.3+ y git.

```bash
git clone https://github.com/ngromero86/refiner
cd refiner
bun install
```

Para usarlo desde cualquier sitio, compila un binario único (no necesita Bun ni
`node_modules` en la máquina destino):

```bash
bun run build            # → dist/refiner (~66 MB, autónomo)
mv dist/refiner ~/.local/bin/
```

O ejecútalo directamente desde el repo:

```bash
bun run src/index.ts     # o: bun start
```

**Dependencias opcionales** (refiner funciona sin ellas, pero se integra si están):

```bash
brew install tmux        # display-popup para nvim/lazygit
brew install neovim      # tecla `e` abre el archivo
brew install lazygit     # tecla `g` abre lazygit
```

## Uso

Lánzalo dentro de cualquier repo git:

```bash
refiner                # cambios sin commitear
refiner main           # diff de la rama actual contra main
```

| Tecla | Acción |
|-------|--------|
| `↑ ↓` | Navegar |
| `← →` | Cambiar entre panel de archivos y panel de diff |
| `enter` | Abrir/expandir (árbol) · abrir o crear thread (diff) |
| `space` | Stage / unstage línea(s) o archivo entero |
| `⇧↑ ⇧↓` | Selección multilínea (para stage o thread sobre varias líneas) |
| `tab` | Ciclar vista DIFF → SPLIT → NORMAL |
| `p` | Fuzzy finder de archivos |
| `c` | Modal con todos los threads |
| `b` | Ocultar el árbol cuando el diff tiene el foco |
| `[` `]` | Estrechar / ensanchar el árbol |
| `e` | Abrir nvim en el archivo actual |
| `g` | Abrir lazygit |
| `r` | Refrescar (re-lee `comments.json` y `git status`) |
| `q` | Salir |

Dentro de un thread: `r` responder · `e` editar mensaje · `d` borrar mensaje ·
`D` borrar thread · `g` ir al código · `⌃u`/`⌃d` scroll · `esc` cerrar.
Al escribir un comentario: `alt+enter` (o `alt+s` / `ctrl+s`) guarda, `esc` cancela.

El footer lista los atajos del panel enfocado; cambia según dónde estés.

## Personalizar

El tema vive en `~/.config/refiner/config.toml` (XDG). Si no existe, se usan los
defaults. Los campos ausentes caen a default, así que puedes poner solo lo que
quieras cambiar.

```toml
# Paleta semántica (los nombres describen el ROL, no el color).
primary    = "#d48472"   # nombre de app, borde del header, borde de modales
accent     = "#d99a3a"   # hotkeys del footer, badge M, dirs, ▶ marker
focus      = "#c4ba6e"   # panel enfocado, label de modo
muted      = "#4a3a2e"   # gutter de números, borde inactivo
foreground = "#e6cfa8"   # texto por defecto (contexto, modales, snippets)

# Hunks del diff
add_bg  = "#0d2117"
del_bg  = "#211517"
add_fg  = "#56d364"      # también pinta el badge A en el árbol
del_fg  = "#f85149"      # también pinta D, errores y el label OUTDATED

staged_bg = "#0d1a2e"
staged_fg = "#4493f8"

# Indicador "hay comentarios aquí" (gutter + ● en árbol + banda del minimapa)
comment       = "#5a2638"
comment_label = "#f5e6c8"   # texto sobre el fondo del gutter

cursor_bg  = "#26211e"   # fila bajo el cursor
background = "#1c1714"   # fondo de los modales (deben ser opacos)
```

Las preferencias que refiner escribe él mismo (ancho del árbol, auto-hide) van
aparte, en `~/.config/refiner/state.json`. La vista **no** se persiste: cada sesión
arranca en DIFF.

## Agentes de IA

refiner comparte el store con la extensión **Refiner** de VSCode: los threads viven
en `.refiner/comments.json` en la raíz del repo, y humanos, editor y agentes leen y
escriben el mismo fichero. refiner re-lee al pulsar `r`.

### Esquema

```jsonc
{
  "version": 1,
  "threads": [
    {
      "id": "t-ms9j4trq-1",
      "file": "src/app.ts",          // ruta relativa al repo
      "range": { "start": 84, "end": 86 },   // 1-based, inclusivo
      "status": "open",              // "open" | "resolved"
      "comments": [
        {
          "id": "c-ms9j4trq-2",
          "author": "angel",         // libre
          "role": "user",            // "user" (humano) | "assistant" (agente)
          "body": "[suggestion] Usa el índice byFile en lugar de scan completo.",
          "createdAt": "2026-07-31T22:44:09.025Z"
        }
      ],
      "anchor": { "lines": [], "before": [], "after": [] }  // lo mantiene VSCode
    }
  ]
}
```

`anchor` es el snapshot de contenido que la extensión usa para reanclar threads
cuando el código se mueve. refiner **no** lo escribe, pero lo preserva intacto al
guardar — si lo borrara, el editor perdería la capacidad de seguir el thread.

Convenciones de severidad (prefijo en `body`, opcional pero recomendado):
- `[must-fix]` — bug, vulnerabilidad o data loss
- `[suggestion]` — mejora concreta con razón clara
- `[question]` — algo que no entiendes, pide aclaración
- `[nit]` — detalle menor pero accionable

### Regla crítica para agentes

**Los agentes NUNCA marcan threads como `resolved` ni los borran.** Cuando un agente
responde o aplica un cambio, deja `status = "open"` y añade un comentario nuevo
describiendo qué hizo. **Resolver o borrar es decisión humana** — el humano valida,
abre refiner y borra el thread con `D`.

### Skills

Como el store es el mismo, valen las skills que ya usa la extensión, sin duplicar
nada:

| Skill | Para qué |
|-------|----------|
| `refine-review` | Revisar el diff actual y dejar threads nuevos. |
| `refine-resolve` | Leer threads abiertos, aplicar los cambios y responder en cada uno. |

## Desarrollo

```bash
bun test           # tests unitarios + integración contra git real
bun run typecheck  # tsc --noEmit
```

El motor de diff (`src/diff.ts`) está cubierto por fixtures generados con la
implementación Go original: `bun test` comprueba que `buildPartialPatch` produce el
**mismo patch byte a byte** sobre un corpus de 14 diffs reales × 8 estrategias de
selección, incluyendo ficheros sin newline final. Además
`test/staging.integration.test.ts` monta repos git de verdad y verifica que
`git apply --cached` acepta cada patch y que el índice queda exacto. Si tocas
`src/diff.ts`, esos tests son el contrato.

## Licencia

MIT.
