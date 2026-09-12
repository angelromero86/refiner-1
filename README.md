# refiner

TUI de revisión de código para git. Inspirado en lazygit / GitHub diff, pensado para
trabajar codo a codo con agentes de IA (Claude Code, Cursor, etc.) sobre el mismo
fichero de threads — el mismo que usa la extensión **Refiner** de VSCode.

Dos cosas que no suelen ir juntas: **staging línea a línea** (partes un cambio grande
en commits limpios sin salir del diff) y **threads de revisión anclados al código**,
que viven en `.refiner/comments.json` dentro del repo y que un agente puede leer y
responder.

```
╭──────────────────────────────────────────────────────────────────────────────────────╮
│ refiner · uncommitted · CHANGES · DIFF       12 files · 2 staged · 4 threads  k keys │
╰──────────────────────────────────────────────────────────────────────────────────────╯
╭──────────────────────────────╮╭─ src/app.ts ─────────────────────────────────────────╮
│ ▾ src/                       ││    639  639 │ jumpToHunk(delta) {                   ▐│
│ ├─ app.ts                ● M ││    640    - │ const starts = scanAll(this.rows)     ▐│
│ ├─ view.ts                 M ││ ▶    +  641 │ const starts = hunkStarts(flags())    ▌│
│ └─ render.ts             ●   ││    641  642 │ if (starts.length === 0) return       ▐│
│ ▾ test/                      ││    642  643 │ this.centerCursor()                    │
│ └─ hunks.test.ts           A ││    643  644 │ }                                      │
╰──────────────────────── 2/7 ─╯╰───────────────────────────────── L 641 · 641/899 ────╯
```

Cabecera: repo · modo · **CHANGES/ALL** · **DIFF/SPLIT/NORMAL** … contadores y el
recordatorio de `k`. Sin barra de atajos fija: el keymap completo vive detrás de `k`
(o `?`) y así el diff se queda esa fila. La posición (`2/7` en el árbol,
`L 641 · 641/899` en el diff) va en el borde inferior de cada panel, donde no cuesta
filas.

En el árbol, `●` marca los ficheros con threads y la última columna es el badge de
estado de git (`M`, `A`, `D`, `R`, `C`, `?`…); las carpetas llevan un glifo de Nerd
Font configurable (aquí dibujado como `▾`), siempre en el color de acento. El
**nombre** de la carpeta, en cambio, se colorea por lo que queda pendiente debajo:
acento mientras algo de su subárbol esté sin stagear, el azul de *staged* cuando
todo lo que cambió ya está en el índice, y como un fichero cualquiera si ahí abajo
no ha cambiado nada.

El árbol sigue al fichero abierto: cambiar de modo (`tab`), elegir un fichero en el
buscador (`⌃p`) o saltar a un thread abren las carpetas que hagan falta y dejan el
cursor encima. Si el otro modo no lista ese fichero — un fichero sin cambios al
volver a CHANGES — la selección se suelta y el árbol se queda como estaba.

En el diff, las dos columnas de números son la línea antigua y la nueva — un `+` o un `-` ocupa la que falta — y la columna
de la derecha del todo es el minimapa.

Stack: Bun + [OpenTUI](https://opentui.com) (núcleo nativo en Zig). Port de
[eleview](https://github.com/ngromero86/eleview) (Go + bubbletea), por
[Angel Romero](https://github.com/ngromero86) con Claude Code.

## Características

- **Diff viewer** — tres vistas: unificada (DIFF), split (SPLIT) y "normal" (el
  archivo tal como queda después del cambio). Scroll fluido, sin re-render de todo el
  buffer.
- **Syntax highlighting** — tree-sitter sobre el diff, con paleta **Gruvbox Dark**.
  Los fondos verde/rojo de añadido/borrado quedan como wash y el código conserva sus
  colores de token encima, así que se lee como código y no como un bloque teñido.
- **Staging line-level** — `space` stagea/unstagea la línea o la selección bajo el
  cursor; parte el patch y se lo pasa a `git apply --cached`.
- **Threads de revisión** — anclados a `(fichero, rango de líneas)`, persistidos en
  `.refiner/comments.json`. Editables a mano, por la extensión de VSCode o por un
  agente.
- **CHANGES / ALL** — `tab` en el árbol cambia entre "solo lo que ha cambiado" y
  "todo el repo", para poder comentar ficheros que nadie ha tocado.
- **Navegación por hunks** — `h` / `H` saltan al siguiente / anterior bloque de
  líneas cambiadas, centrándolo en el panel.
- **Minimapa** — banda de color por zona del archivo (thread > staged > del > add)
  más el thumb del viewport, en la columna derecha del panel.
- **Fuzzy finder** — `p` (o `⌃p`) abre un picker multi-término: `con task` encuentra
  `Controllers/Task.ts`.
- **Tema configurable** — paleta semántica + colores de sintaxis en
  `~/.config/refiner/config.toml`.
- **Editor configurable** — `e` abre tu editor **en la línea del cursor**. En tmux o
  zellij se abre en una ventana flotante con borde y título; `g` abre lazygit igual.
- **Dos modos**:
  - `refiner` → cambios sin commitear (working tree + index)
  - `refiner <branch>` → review contra `<branch>...HEAD`

## Instalar

Requiere [Bun](https://bun.sh) 1.3+ y git.

```bash
git clone https://github.com/ngromero86/refiner
cd refiner
bun install
bun run src/index.ts     # o: bun start
```

### Binario compilado

Para usarlo desde cualquier sitio, compila un binario único (no necesita Bun ni
`node_modules` en la máquina destino) e instálalo:

```bash
bun run install-local              # compila e instala en ~/.local
bun run install-local --no-build   # instala lo que ya haya en dist/
bun run install-local --prefix /opt/refiner
bun run install-local --uninstall  # quitarlo
```

El layout es *payload + enlace*: el binario y `refiner-assets/` van juntos a
`~/.local/share/refiner/`, y `~/.local/bin/refiner` es un symlink al binario. Eso
deja 130 MB fuera del directorio que está en el PATH y sigue funcionando porque un
binario compilado de Bun resuelve `process.execPath` **a través del symlink** hasta
su ruta real, que es justo donde están los assets.

El script reemplaza el directorio de assets en vez de copiarlo encima (si no, se
anida dentro de sí mismo y arrastra ficheros del build anterior), renombra el
binario en lugar de escribir sobre él (`ETXTBSY` si lo estás ejecutando), comprueba
que el sidecar está completo antes y después de copiar, y arranca `refiner --help`
por el symlink para verificarlo. Nunca borra lo que no ha creado él: un `refiner`
que sea un fichero real, o un symlink a otro sitio, se reporta y se planta
(`--force` solo repunta el symlink).

Si prefieres hacerlo a mano, `bun run build` deja `dist/refiner` (~130 MB) y
`dist/refiner-assets/` (~3.7 MB).

**Copia las dos cosas.** El binario lleva dentro el renderer nativo, pero el worker
de tree-sitter no puede arrancar desde el filesystem virtual de Bun, así que la
runtime WASM y las gramáticas van en `refiner-assets/` **al lado del ejecutable**.
refiner busca ese directorio junto al binario al arrancar; si no está, funciona todo
igual **menos** el syntax highlighting (nunca falla ruidosamente, simplemente no
colorea).

Si tienes los assets en otro sitio, `OTUI_ASSET_ROOT` apuntando a ese directorio gana
sobre la detección automática.

### Dependencias opcionales

refiner funciona sin ellas, pero se integra si están:

```bash
brew install tmux        # ventana flotante para el editor y lazygit
brew install neovim      # editor por defecto si no configuras otro
brew install lazygit     # tecla `g`
```

Sin tmux ni zellij, `e` y `g` ocupan toda la pantalla mientras duran: sin
multiplexor no hay forma de darle a otro proceso un trozo del terminal.

## Uso

Lánzalo dentro de cualquier repo git:

```
refiner — git code-review TUI

usage:
  refiner              review uncommitted changes (working tree + index)
  refiner <branch>     review the current branch against <branch>...HEAD

keys:
  press k inside refiner for the full keymap

config:
  ~/.config/refiner/config.toml
  (optional — set your editor there, e.g. editor = "nvim")

state:
  ~/.config/refiner/state.json
```

En modo review (`refiner main`) el staging está desactivado: `space` no hace nada,
porque no estás mirando el working tree sino el diff de la rama contra su
merge-base. Los threads funcionan igual en los dos modos.

### CHANGES y ALL

El árbol arranca en **ALL**: lista *todo* el repo. `tab` (con el foco en el árbol) lo
cambia a **CHANGES**, solo los ficheros que difieren.

ALL es `git ls-files --cached --others --exclude-standard`: tracked + untracked menos
lo que excluya `.gitignore`, así que no verás `node_modules/` ni build output. Es el
modo por defecto porque el árbol nunca queda vacío — en un repo sin cambios, CHANGES
no lista nada.

Para qué: para anclar un thread en un fichero que **nadie ha tocado** ("esto habría
que migrarlo", "aquí falta un test"). Un fichero sin cambios se muestra como un diff
hecho solo de líneas de contexto, y la vista degrada a **NORMAL** aunque tuvieras
DIFF o SPLIT seleccionado — las otras dos enseñarían el mismo texto dos veces. En
cuanto vuelves a un fichero con diff real, recupera la vista que tenías.

Detalles de ALL: al entrar la primera vez pliega todas las carpetas menos las que
llevan al fichero seleccionado (un repo de cientos de ficheros es ilegible del todo
abierto), los ficheros gigantes y los binarios se sustituyen por una línea de aviso,
y `space` no hace nada sobre un fichero sin cambios. Al volver a CHANGES, si el
fichero que estabas viendo no tiene cambios, el panel derecho se vacía.

## Teclas

Esta tabla es el mismo contenido que te enseña `k` dentro de la app, en el mismo
orden. La fuente de verdad es [`src/keymap.ts`](src/keymap.ts).

**Paneles**

| Tecla | Acción |
|-------|--------|
| `← →` | Mover el foco entre el árbol de ficheros y el diff |
| `b` | Auto-ocultar el árbol mientras el diff tiene el foco |
| `[` `]` | Estrechar / ensanchar el árbol |

**Árbol de ficheros**

| Tecla | Acción |
|-------|--------|
| `↑ ↓` | Navegar (da la vuelta) |
| `enter` | Expandir o plegar una carpeta · enfocar el diff en un fichero |
| `tab` | Cambiar entre CHANGES y ALL — ALL lista todo el repo, para poder leer y comentar ficheros que nadie ha tocado |
| `space` | Stage / unstage del fichero entero |
| `p` · `⌃p` | Fuzzy finder de ficheros — términos separados por espacios, sin importar el orden |

**Diff**

| Tecla | Acción |
|-------|--------|
| `↑ ↓` | Scroll |
| `⇧↑ ⇧↓` | Extender una selección multilínea |
| `⌃u ⌃d` | Media página arriba / abajo (también `pgup` / `pgdn`) |
| `home` / `end` | Ir a la primera / última fila (`G` también va al final) |
| `h` / `H` | Saltar al siguiente / anterior hunk — el siguiente bloque de líneas cambiadas, dando la vuelta al llegar al final |
| `space` | Stage / unstage de la línea, o de toda la selección |
| `enter` | Abrir el thread de esta línea, o empezar uno nuevo |
| `tab` | Ciclar la vista: DIFF → SPLIT → NORMAL |
| `e` | Abrir el fichero en tu editor, en la línea del cursor |

**Threads de revisión**

| Tecla | Acción |
|-------|--------|
| `c` | Listar todos los threads del repo (un thread contiene uno o más comentarios) |
| `↑ ↓` | Moverse entre los comentarios de un thread |
| `⌃u ⌃d` | Scroll de un comentario largo sin cambiar la selección |
| `g` | Ir al código al que está anclado el thread |
| `r` | Responder — añade un comentario a este thread |
| `e` | Editar el comentario seleccionado |
| `d` / `D` | Borrar el comentario seleccionado / el thread entero |
| `alt+enter` | Guardar lo que has escrito (`alt+s` y `⌃s` también valen) |
| `esc` | Cancelar la escritura, o cerrar el thread |

**Sesión**

| Tecla | Acción |
|-------|--------|
| `r` | Refrescar — re-lee git y `.refiner/comments.json` |
| `g` | Abrir lazygit |
| `k` | Esta ayuda (`?` también) |
| `t` | Selector de tema — `↑↓` lo aplica de verdad sobre el diff que tienes detrás, `enter` lo deja puesto, `esc` devuelve el que había |
| `q` / `esc` | Salir — pide confirmación primero |
| `⌃c` | Salir inmediatamente, desde donde sea, sin confirmación |

Dentro de cada overlay, además:

- **Picker de ficheros** (`p`): `↑↓` o `⌃p` / `⌃n` para moverte, `enter` abre, `esc`
  cierra. Todo lo demás va al campo de texto.
- **Lista de threads** (`c`): `↑↓`, `enter` abre el thread seleccionado, `esc` o `c`
  cierran.
- **Ayuda** (`k`): `↑↓`, `⌃u` / `⌃d`, `home`; `esc`, `k`, `?` o `q` cierran.
- **Temas** (`t`): `↑↓` previsualiza, `enter` guarda la elección, `esc`, `t` o `q`
  restauran el tema anterior.
- **Confirmación de salida**: `y` o `enter` salen, `n`, `esc` o `q` vuelven.

Los overlays son modales: se tragan cualquier otra tecla en vez de dejarla actuar
sobre lo que hay detrás.

`r`, `g`, `c`, `p`, `k`, `t`, `b`, `[`, `]`, `q` y las flechas `← →` se resuelven antes que
el panel enfocado, así que funcionan igual desde el árbol y desde el diff.

`j`/`k` **no** navegan. Eran un alias vim no documentado y `k` hacía falta para la
ayuda; usa las flechas, `⌃u`/`⌃d`, `home`/`end` o `G`.

## Personalizar

La configuración vive en `~/.config/refiner/config.toml` (o
`$XDG_CONFIG_HOME/refiner/config.toml`). **Ese fichero no existe hasta que lo creas**
— refiner nunca lo escribe, solo lo lee al arrancar. Sin él usa los defaults
(Gruvbox Dark, y `$VISUAL` / `$EDITOR` / `nvim` como editor), y los campos ausentes
también caen a default, así que puedes poner solo lo que quieras cambiar.

En el repo tienes [`config.example.toml`](config.example.toml) con **todas** las
claves comentadas y sus valores por defecto:

```bash
mkdir -p ~/.config/refiner
cp config.example.toml ~/.config/refiner/config.toml
```

`refiner --help` te imprime la ruta exacta que está usando.

### Referencia

**Editor y ventanas flotantes**

| Clave | Default | Qué hace |
|-------|---------|----------|
| `editor` | `$VISUAL` → `$EDITOR` → `nvim` | Lo que abre `e`. Se parte por espacios: `editor = "code -w"` funciona. |
| `editor_line` | deducido del binario | Cómo se le pasa la línea: `"plus"` (`nvim +42 fichero`), `"suffix"` (`hx fichero:42`) o `"none"`. Se deduce del nombre del ejecutable — `vi`/`vim`/`nvim`/`emacs`/`emacsclient`/`nano`/`pico`/`micro`/`joe`/`kak` → `plus`; `druk`/`hx`/`helix`/`subl`/`zed`/`code`/`codium`/`cursor` → `suffix`; lo desconocido → `plus`. |
| `popup_width` | `90` | Ancho de la ventana flotante de `e` y `g`, en % del terminal. Se recorta a 20..100. |
| `popup_height` | `90` | Alto, igual. |

Solo tmux y zellij respetan `popup_*`: sin multiplexor el proceso hijo se queda la
pantalla entera y no hay nada que dimensionar.

**Tema**

| Clave | Default | Qué hace |
|-------|---------|----------|
| `theme` | `"gruvbox-dark"` | Paleta base: `"gruvbox-dark"`, `"gruvbox-light"` o `"vesper"`. Un nombre que no existe se ignora y arranca con el default. Lo que elijas con `t` manda sobre esta clave |

**Paleta** — se aplica encima del tema; los nombres describen el ROL, no el color
(los defaults de la tabla son los de `gruvbox-dark`):

| Clave | Default | Dónde se ve |
|-------|---------|-------------|
| `primary` | `#fe8019` | Nombre del repo en el header, borde del header, borde de los modales, badge `?` (untracked) |
| `accent` | `#fabd2f` | Teclas resaltadas en header y overlays, badge `M`, directorios del árbol, marcador `▶` |
| `focus` | `#8ec07c` | Borde del panel enfocado, labels de modo del header, badge `R`/`C` |
| `muted` | `#7c6f64` | Gutter de números, borde del panel inactivo |
| `foreground` | `#ebdbb2` | Texto por defecto: contexto del diff, cuerpos de comentario, tinte del thumb del minimapa |
| `add_bg` | `#32361a` | Fondo de las líneas añadidas |
| `del_bg` | `#402120` | Fondo de las líneas borradas |
| `add_fg` | `#b8bb26` | Signo `+`, badge `A` |
| `del_fg` | `#fb4934` | Signo `-`, badge `D`, banner de error, label `OUTDATED` |
| `staged_bg` | `#23303d` | Fondo de las líneas que ya están en el índice |
| `staged_fg` | `#83a598` | Primer plano de esas líneas, y su banda en el minimapa |
| `thread` | `#4c2b3d` | **Fondo** del gutter en las líneas comentadas, y la banda del minimapa. Tiene que dejar leer texto encima |
| `thread_label` | `#fbf1c7` | Los números de línea dibujados sobre ese fondo |
| `thread_marker` | `#d3869b` | El `●` junto a los ficheros con threads en el árbol. Es un **primer plano**: por eso es una clave distinta de `thread`, que es un fondo oscuro |
| `tree_guide` | `#665c54` | Las líneas `├ └ │` que dibujan la estructura del árbol |
| `cursor_bg` | `#3c3836` | Fila bajo el cursor |
| `background` | `#282828` | Lienzo de los paneles y fondo de los modales. Los overlays tienen que ser opacos o el diff se transparenta a través de su texto |

Los fondos de add/del son suaves a propósito: el syntax highlighting pinta encima, y
un fondo saturado taparía los colores de token.

**Sintaxis**

| Clave | Default | Qué hace |
|-------|---------|----------|
| `syntax_highlight` | `true` | `false` vuelve al add/del en verde/rojo plano, sin colores de token |
| `[syntax]` | Gruvbox | Tabla `grupo de captura → color` |

La tabla `[syntax]` se **mezcla** sobre los defaults, así que recolorear un grupo no
borra el resto. La búsqueda cae por puntos: `keyword.function` usa `keyword` si no
tiene entrada propia, igual que en los editores — recolorear una cosa son dos líneas,
no una tabla entera. Los grupos que trae por defecto son `keyword`, `conditional`,
`repeat`, `label`, `exception`, `function`, `string`, `character`, `literal`,
`number`, `boolean`, `float`, `constant`, `type`, `constructor`, `attribute`,
`annotation`, `title`, `variable`, `property`, `parameter`, `field`, `namespace`,
`module`, `operator`, `text`, `emphasis`, `tag`, `include`, `preproc`, `reference`,
`uri`, `punctuation` y `comment`.

**Iconos**

| Clave | Default | Qué hace |
|-------|---------|----------|
| `[icons] folder_open` | `` — U+F07C, nf-fa-folder_open | Glifo de carpeta abierta en el árbol |
| `[icons] folder_closed` | `` — U+F07B, nf-fa-folder | Glifo de carpeta cerrada |

Vale cualquier string, emoji incluido: el ancho se mide en celdas y se rellena, así
que un emoji de 2 celdas no descuadra los nombres.

### Temas

`t` abre el selector. Vienen tres paletas de serie:

| Nombre | Qué es |
|--------|--------|
| `gruvbox-dark` | El default: cálido, poco contraste, oscuro |
| `gruvbox-light` | La misma paleta sobre papel, para sitios con luz |
| `vesper` | Casi monocromo oscuro, con naranja y menta como únicos acentos |

Moverte por la lista **aplica** el tema de verdad: los paneles siguen ahí detrás del
overlay, que es la única forma de saber si un tema se lee bien en un diff. `enter` lo
deja puesto y lo recuerda en `state.json`; `esc` devuelve el que tenías.

En el fichero de config, `theme = "vesper"` elige la paleta base de arranque. Manda
lo último que hayas dicho: si alguna vez elegiste uno con `t`, ese gana; mientras no
lo hayas hecho, manda el fichero. Las claves de color sueltas (`focus = "#ff00ff"`,
`[syntax]`) son tuyas y se aplican **encima** de cualquier tema, también al cambiar
de tema con `t`.

En [`themes/`](themes/) hay además paletas listas para copiar al config —
`omarchy.toml` es la ochre cálida con la que refiner nació. Solo llevan el chrome;
los colores de sintaxis caen a los grupos Gruvbox de serie.

### Lenguajes

De OpenTUI vienen **TypeScript** (`.ts .tsx .mts .cts`), **JavaScript**
(`.js .jsx .mjs .cjs`), **Markdown** (`.md .markdown`) y **Zig** (`.zig`).

Las demás las trae refiner en `assets/parsers/`: **JSON** (`.json`), **TOML**
(`.toml`), **CSS** (`.css`), **SCSS** (`.scss`), **HTML** (`.html .htm`) y **XML**
(`.xml .svg`). Van compiladas a WebAssembly y se cargan desde disco, así que
refiner no hace ninguna petición de red por su cuenta — ni al arrancar ni nunca.
`scripts/fetch-parsers.ts` las regenera y documenta de dónde sale cada una.

Cualquier otra extensión se muestra sin colorear, sin errores ni ruido.

Si instalas el binario compilado, copia `refiner-assets/` junto a él: ahí viajan
las gramáticas, y sin ese directorio el highlighting se apaga en silencio.

### Estado

Las preferencias que refiner escribe él mismo van aparte, en
`~/.config/refiner/state.json`: el ancho del árbol (`[` `]`), el auto-hide (`b`) y el
tema que hayas elegido con `t`.
La vista **no** se persiste: cada sesión arranca en DIFF, y CHANGES/ALL tampoco —
cada sesión arranca en CHANGES.

## Threads y agentes

refiner comparte el store con la extensión **Refiner** de VSCode: los threads viven
en `.refiner/comments.json` en la raíz del repo, y humanos, editor y agentes leen y
escriben el mismo fichero. refiner guarda en disco en cuanto creas, editas o borras
algo — un comentario que solo existiera en memoria sería invisible para los otros dos
clientes.

Y al revés: **refiner se recarga solo**. Vigila `.refiner/` y `.git/`, así que cuando
un agente responde a un thread, o haces `git add` en otra terminal, lo ves aparecer
sin pulsar nada. Conserva dónde estabas — fichero abierto, línea, selección y foco.

Vigila también **el working tree**, así que si un agente edita código el diff se
actualiza solo. Eso necesita un watch recursivo, y para que un `bun install` no
provoque una tormenta de recargas, qué rutas ignorar **lo decide git**
(`git ls-files --others --directory --ignored`) en vez de una lista negra escrita a
mano: se respeta tu `.gitignore` tal cual. La lista se calcula al arrancar, así que un
directorio que pase a estar ignorado más tarde no se filtra hasta el siguiente
lanzamiento.

Mientras tengas un modal abierto no se refresca por debajo — sería hostil recargar a
media redacción de un comentario, y los índices que sostiene el modal podrían moverse.
Se guarda el evento y se aplica en cuanto cierras. Para desactivarlo del todo:
`watch = false` en el config.

### Vocabulario

Dos conceptos, y la UI usa siempre estas palabras para no confundirlos:

- **Thread** — está anclado a `(fichero, rango de líneas)`, tiene `status` y
  contiene **uno o más comentarios**. Es lo que cuenta el header, lo que lista `c`,
  lo que marca el `●` del árbol y la banda del minimapa, y lo que borras con `D`.
- **Comentario** — un mensaje dentro de un thread: autor, rol y cuerpo. Es lo que
  añade `r` (responder), lo que edita `e` y lo que borra `d`.

En la lista de `c`, `+2` detrás del autor significa que ese thread tiene dos
comentarios más además del primero, y el snippet es la primera línea del primer
comentario. Un thread marcado `[outdated]` en la lista (`· OUTDATED` en su cabecera)
es uno cuyo fichero ya no existe, o cuyo rango cae más allá del final del fichero.

### Esquema de `.refiner/comments.json`

Es un **contrato** compartido con la extensión de VSCode y con los agentes: la forma
del fichero no es propiedad de ningún cliente, así que ninguno la cambia por su
cuenta.

```jsonc
{
  "version": 1,
  "threads": [
    {
      "id": "t-ms9j4trq-1",
      "file": "src/app.ts",                    // ruta relativa al repo, con /
      "range": { "start": 84, "end": 86 },     // 1-based, inclusivo
      "status": "open",                        // "open" | "resolved"
      "comments": [
        {
          "id": "c-ms9j4trq-2",
          "author": "angel",                   // libre
          "role": "user",                      // "user" (humano) | "assistant" (agente)
          "body": "[suggestion] Usa el índice byFile en lugar de scan completo.",
          "createdAt": "2026-07-31T22:44:09.025Z"   // ISO-8601
        }
      ],
      "anchor": { "lines": [], "before": [], "after": [] }  // opcional; lo mantienen refiner y VSCode
    }
  ]
}
```

Reglas del formato:

- **`anchor` es el snapshot de contenido** (las líneas del thread más tres de
  contexto a cada lado) con el que refiner y la extensión reanclan los threads
  cuando el código se mueve: los dos lo capturan al crear un thread, lo rellenan si
  falta y corrigen `range` cuando encuentran el texto en otra línea. Un thread cuyo
  texto ya no aparece se marca `outdated` en el TUI y conserva su `range`. Los
  agentes **no** lo escriben. Cualquier campo que no reconozcas se conserva.
- **Serialización**: `JSON.stringify(data, null, 2)` más un `\n` final. Es
  literalmente lo que escriben refiner y la extensión, así que no se pelean por el
  whitespace en git; escribe igual desde un agente.
- **JSON inválido**: refiner enseña un banner de error y arranca con un store vacío;
  la extensión avisa y se queda con lo último que pudo leer. El fichero no se pierde
  en ninguno de los dos casos, pero nadie ve los threads hasta arreglarlo.
- **`range` es 1-based e inclusivo**, sobre el lado NUEVO del diff (los números que
  ve el humano en el gutter).

Convenciones de severidad (prefijo en `body`, opcional pero recomendado):

- `[must-fix]` — bug, vulnerabilidad o data loss
- `[suggestion]` — mejora concreta con razón clara
- `[question]` — algo que no entiendes, pide aclaración
- `[nit]` — detalle menor pero accionable

### Regla crítica para agentes

**Los agentes NUNCA marcan threads como `resolved` ni los borran.** Cuando un agente
responde o aplica un cambio, deja `status = "open"` y añade un comentario nuevo
describiendo qué hizo. **Cerrar es decisión humana** — el humano valida el cambio y
borra el thread con `D` en refiner, o pulsa ✓ en VSCode.

(refiner por su parte tampoco escribe nunca `status: "resolved"`: lo lee y lo enseña
en la cabecera del thread, pero su única forma de cerrar es borrar.)

### Skills

El repo trae las dos skills de Claude Code que mueven este flujo, en
[`skills/`](skills/):

| Skill | Para qué |
|-------|----------|
| `refine-review` | Revisar el diff actual y dejar threads nuevos en `.refiner/comments.json`. No toca código. |
| `refine-resolve` | Leer los threads abiertos, aplicar los cambios pedidos y responder en cada uno. No resuelve ni borra nada. |

Instalación, desde el clon de refiner:

```bash
bun run install-skills                    # ~/.claude/skills — todos tus proyectos
bun run install-skills --project          # ./.claude/skills — solo el repo actual
bun run install-skills --project ../otro  # ./.claude/skills de otro repo
bun run install-skills --uninstall        # quitarlas
```

Instala por symlink, así que un `git pull` de refiner actualiza también las skills.
Es idempotente: re-ejecutarlo no rompe nada.

Nunca sobrescribe lo que no ha creado él. Si ya tienes un directorio propio con ese
nombre, se planta y te dice que lo muevas tú — ni siquiera `--force` lo borra,
porque eso sería tirar trabajo tuyo por un flag. `--force` solo sirve para repuntar
un symlink que apunte a otro sitio. Y `--uninstall` únicamente borra sus propios
enlaces.

Si prefieres no depender del clon, copia los directorios de [`skills/`](skills/) a
mano en lugar de usar el script.

Luego, dentro de Claude Code: `/refine-review` para que revise, `/refine-resolve`
para que aplique. Después pulsa `r` en refiner y verás sus respuestas.

Las mismas skills sirven si usas la extensión de VSCode: el store es el mismo.

## Desarrollo

```bash
bun test           # tests unitarios + integración contra git real
bun run typecheck  # tsc --noEmit
bun run build      # dist/refiner + dist/refiner-assets/
bun run install-local  # lo anterior + instalarlo en ~/.local
bun start          # = bun run src/index.ts
```

El motor de diff (`src/diff.ts`) está cubierto por fixtures generados con la
implementación Go original: `bun test` comprueba que `buildPartialPatch` produce el
**mismo patch byte a byte** sobre un corpus de 14 diffs reales × 8 estrategias de
selección, incluyendo ficheros sin newline final. Además
`test/staging.integration.test.ts` monta repos git de verdad y verifica que
`git apply --cached` acepta cada patch y que el índice queda exacto. Si tocas
`src/diff.ts`, esos tests son el contrato.

Si añades una tecla en `src/dispatch.ts`, añádela también a `src/keymap.ts`: ese
fichero es lo único que alimenta el overlay de `k`, así que una tecla que no esté ahí
es una tecla que nadie va a descubrir.

[`CLAUDE.md`](CLAUDE.md) recoge los invariantes que no se ven leyendo un fichero
suelto (espacios de índices del staging, quirks de OpenTUI, cómo se alinea el syntax
highlighting). Léelo antes de tocar `diff.ts`, `staging.ts` o `syntax.ts`.

## Licencia

MIT — ver [LICENSE](LICENSE).
