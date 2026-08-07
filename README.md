# refiner

TUI de revisión de código para git. Inspirado en lazygit / GitHub diff, pensado para
trabajar codo a codo con agentes de IA (Claude Code, Cursor, etc.) sobre el mismo
fichero de threads — el mismo que usa la extensión **Refiner** de VSCode.

```
┌─ refiner · uncommitted · 3 archivos · 4 threads ─────────────────────────┐
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
- **Syntax highlighting** — tree-sitter sobre el diff, con paleta **Gruvbox Dark**.
  Los fondos verde/rojo de añadido/borrado quedan como wash y el código conserva sus
  colores de token encima, así que se lee como código y no como un bloque teñido.
- **Staging line-level** — `space` stagea/unstagea la línea o la selección bajo el
  cursor; parte el patch y se lo pasa a `git apply --cached`.
- **Threads de revisión** — anclados a `(file, start, end)`, persistidos en
  `.refiner/comments.json`. Editables a mano, por la extensión de VSCode o por un
  agente.
- **Minimapa** — banda de color por zona del archivo (thread > staged > del > add)
  más el thumb del viewport, en la columna derecha del panel.
- **Fuzzy finder** — `p` abre un picker multi-término: `con task` encuentra
  `Controllers/Task.ts`.
- **Tema configurable** — paleta semántica + colores de sintaxis en
  `~/.config/refiner/config.toml`.
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
bun run build            # → dist/refiner (~66 MB) + dist/refiner-assets/
cp -R dist/refiner dist/refiner-assets ~/.local/bin/
```

**Copia las dos cosas.** El binario lleva dentro el renderer nativo, pero el worker
de tree-sitter no puede arrancar desde el filesystem virtual de Bun, así que la
runtime WASM y las gramáticas (~3.7 MB) van en `refiner-assets/` al lado del
ejecutable. refiner lo busca ahí al arrancar; si no está, funciona todo igual
**menos** el syntax highlighting.

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
| `k` | Ayuda: todos los atajos (`?` también) |
| `b` | Ocultar el árbol cuando el diff tiene el foco |
| `[` `]` | Estrechar / ensanchar el árbol |
| `e` | Abrir nvim en el archivo actual |
| `g` | Abrir lazygit |
| `r` | Refrescar (re-lee `comments.json` y `git status`) |
| `q` | Salir (pide confirmación; `⌃c` sale sin preguntar) |

Dentro de un thread: `r` responder · `e` editar mensaje · `d` borrar mensaje ·
`D` borrar thread · `g` ir al código · `⌃u`/`⌃d` scroll · `esc` cerrar.
Al escribir un comentario: `alt+enter` (o `alt+s` / `ctrl+s`) guarda, `esc` cancela.

**`k` abre la lista completa**, agrupada por contexto y scrolleable. No hay barra de
atajos fija: ocupaba una fila permanente para repetir siempre lo mismo, así que el
diff se queda con ella. La posición (`1/7` en el árbol, `L 42 · 42/652` en el diff)
va en el borde inferior de cada panel, donde no cuesta filas.

`j`/`k` **no** navegan. Eran un alias vim no documentado y `k` hacía falta para la
ayuda; usa las flechas, `⌃u`/`⌃d`, `home`/`end` o `G`.

## Personalizar

El tema por defecto es **Gruvbox Dark**. Vive en `~/.config/refiner/config.toml`
(XDG); si no existe se usan los defaults, y los campos ausentes caen a default, así
que puedes poner solo lo que quieras cambiar.

```toml
# Paleta semántica (los nombres describen el ROL, no el color).
primary    = "#fe8019"   # nombre de app, borde del header, borde de modales
accent     = "#fabd2f"   # hotkeys del footer, badge M, dirs, ▶ marker
focus      = "#8ec07c"   # panel enfocado, label de modo
muted      = "#7c6f64"   # gutter de números, borde inactivo
foreground = "#ebdbb2"   # texto por defecto (contexto, modales, snippets)

# Hunks del diff — fondos suaves para que el código se lea encima
add_bg  = "#32361a"
del_bg  = "#402120"
add_fg  = "#b8bb26"      # signo + del gutter, badge A en el árbol
del_fg  = "#fb4934"      # signo -, badge D, errores y el label OUTDATED

staged_bg = "#23303d"
staged_fg = "#83a598"

# Indicador "aquí hay un thread" (gutter + ● en árbol + banda del minimapa)
thread       = "#4c2b3d"
thread_label = "#fbf1c7"   # texto sobre el fondo del gutter

cursor_bg  = "#3c3836"   # fila bajo el cursor
background = "#282828"   # fondo de los modales (deben ser opacos)

# Apágalo para volver al add/del en verde/rojo plano, sin colores de token.
syntax_highlight = true

# Colores de sintaxis por grupo de captura de tree-sitter. La búsqueda cae por
# puntos: `keyword.function` usa `keyword` si no tiene entrada propia, igual que en
# los editores — así recolorear una cosa son dos líneas, no una tabla entera.
[syntax]
keyword     = "#fb4934"
function    = "#b8bb26"
string      = "#b8bb26"
number      = "#d3869b"
constant    = "#d3869b"
type        = "#fabd2f"
variable    = "#ebdbb2"
operator    = "#ebdbb2"
punctuation = "#a89984"
comment     = "#928374"
tag         = "#8ec07c"
```

En `themes/` hay paletas alternativas listas para copiar — `omarchy.toml` es la
ochre cálida con la que refiner nació.

**Lenguajes.** El highlighting usa las gramáticas que trae OpenTUI:
**TypeScript** (`.ts .tsx .mts .cts`), **JavaScript** (`.js .jsx .mjs .cjs`),
**Markdown** y **Zig**. Cualquier otra extensión se muestra sin colorear, sin
errores ni ruido. OpenTUI puede descargar más gramáticas, pero eso implicaría que
refiner hiciera peticiones de red por su cuenta, así que no lo hace.

Las preferencias que refiner escribe él mismo (ancho del árbol, auto-hide) van
aparte, en `~/.config/refiner/state.json`. La vista **no** se persiste: cada sesión
arranca en DIFF.

## Agentes de IA

refiner comparte el store con la extensión **Refiner** de VSCode: los threads viven
en `.refiner/comments.json` en la raíz del repo, y humanos, editor y agentes leen y
escriben el mismo fichero. refiner re-lee al pulsar `r`.

### Vocabulario

Dos conceptos, y la UI usa siempre estas palabras para no confundirlos:

- **Thread** — está anclado a `(fichero, rango de líneas)`, tiene `status` y
  contiene **uno o más comentarios**. Es lo que cuenta el header, lo que lista `c`,
  lo que marca el `●` del árbol y la banda del minimapa, y lo que borras con `D`.
- **Comentario** — un mensaje dentro de un thread: autor, rol y cuerpo. Es lo que
  añade `r` (responder), lo que edita `e` y lo que borra `d`.

En la lista, `+2` detrás del autor significa que ese thread tiene dos comentarios
más además del primero.

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
