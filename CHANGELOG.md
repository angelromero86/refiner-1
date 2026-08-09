# Changelog

Todos los cambios relevantes de refiner, por versión. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); el proyecto está en
`0.x`, así que la "API pública" es el TUI: teclas, ficheros de configuración y el
formato de `.refiner/comments.json`.

Como no hay tags todavía, cada versión lista los commits que la componen.

## [0.1.3] — 2026-08-09

### Cambiado

- **El nombre de una carpeta ya no es amarillo por ser una carpeta.** Para eso
  está el icono, que sigue siempre en el color de acento. El **nombre** ahora
  dice qué trabajo queda debajo: acento mientras algo del subárbol esté sin
  stagear, el azul de *staged* cuando todo lo que cambió ya está en el índice, y
  el mismo blanco que un fichero cuando ahí abajo no ha cambiado nada. La
  diferencia se nota sobre todo en el modo ALL, donde la mayoría de las carpetas
  del repo no tienen cambios y aun así pedían atención.
- El estado de una carpeta se calcula sobre los **cambios** del subárbol, no
  sobre sus ficheros: un fichero sin cambios ya no cuenta como "pendiente de
  stagear" (`dirState` en `src/tree.ts`, `hasUnstagedChanges` en `src/git.ts`).
  De paso deja de hacer una búsqueda lineal en `App.files` por cada descendiente,
  que en modo ALL convertía el repintado del árbol en cuadrático.
- **El árbol sigue al fichero abierto.** Cambiar de modo con `tab`, elegir un
  fichero en el buscador o saltar a un thread abren las carpetas que hagan falta
  y dejan el cursor encima, en lugar de mover solo el panel derecho. Antes cada
  uno de esos saltos movía el cursor "si la fila estaba visible", que en ALL —
  plegado por construcción — no lo estaba casi nunca. Si el otro modo no lista
  ese fichero, la selección se suelta como hasta ahora.

### Añadido

- `⌃p` como alias del buscador de ficheros (`p` sigue funcionando).
- `test/tree.test.ts` con los tres estados de carpeta, y tres tests más en
  `test/loads.test.ts` para el árbol que sigue al fichero.

<sub>Commits: este.</sub>

## [0.1.2] — 2026-08-09

### Añadido

- **Syntax highlight de lenguajes embebidos en TS/JS.** Una plantilla de Angular
  (`template:` → HTML, `styles:` → CSS) o de lit-html (`` html`…` ``,
  `` css`…` ``) se colorea con su propia gramática en vez de salir como una
  cadena verde de veinte líneas. Las interpolaciones `${…}` conservan los colores
  de TypeScript, y una plantilla sin cerrar o que cruza un salto de hunk no se
  toca — el documento que se parsea es el contexto del diff, no el fichero.
- **Instalador**: `bun run install-local` (`scripts/install.ts`) compila y
  despliega el binario junto a su sidecar en `~/.local/share/refiner`, con el
  symlink en `~/.local/bin`. Verifica que los assets están completos, renombra el
  binario en lugar de escribir sobre él, y comprueba el resultado ejecutándolo
  por el symlink. `--no-build`, `--prefix`, `--uninstall` y `--force`.

### Cambiado

- El paquete pasa a llamarse `refiner` (era `refiner-tui`).

<sub>Commits: `016e694`, `efc6afb`.</sub>

## [0.1.1] — 2026-08-09

### Añadido

- **Gramáticas propias** para json, toml, css, scss, html y xml, que antes caían
  a colores planos de diff. Van commiteadas en `assets/parsers/` y se regeneran
  con `scripts/fetch-parsers.ts`; no se descarga nada en tiempo de ejecución.
  `bun run build` las copia al sidecar del binario.

### Cambiado

- **El frame pierde los bordes**: cabecera, una regla, una fila de títulos donde
  cada mitad describe el panel que tiene debajo, y otra regla más suave. Son
  cinco filas y ocho columnas menos de decoración, y las etiquetas dejan de estar
  en el panel equivocado.
- El foco se marca en el texto (título del panel, fila del cursor), nunca en la
  estructura: las reglas ya no se mueven al cambiar de panel.
- La columna del scrollbar solo se reserva cuando hay algo que scrollear.
- **Markdown vuelve a colorearse**: se descartan las capturas que no son color
  (`spell`, `nospell`, `conceal`, `none`), que enterraban a la que sí lo era, y
  el tema gana los colores `markup.*` que ninguna gramática tree-sitter había
  emitido nunca con los nombres antiguos.

<sub>Commits: `4ac7b3b`.</sub>

## [0.1.0] — 2026-08-07 → 2026-08-08

Port de **eleview** (Go + bubbletea) a Bun + OpenTUI, y todo lo que se construyó
encima antes del primer bump de versión.

### Añadido

- **Staging parcial**: por línea, por selección y por hunk, con `git apply
  --cached` sobre un patch que describe el estado deseado completo (reset y
  aplica), más las cabeceras que git exige para creaciones y borrados. Cubierto
  byte a byte contra los fixtures del original en Go.
- **Threads de revisión** anclados a `(fichero, rango de líneas)` en
  `.refiner/comments.json`, el store que comparte con la extensión de VSCode y
  con los agentes: se preservan los campos ajenos, se fusiona contra el disco en
  cada guardado en lugar de sobrescribir, y un fichero ilegible nunca se
  reescribe.
- **Syntax highlighting** del diff como dos documentos completos (pre y post
  cambio) vía tree-sitter, con temas TOML y `themes/omarchy.toml`.
- **ALL vs CHANGES**: el árbol lista todo el repo o solo lo que cambió, para
  poder anclar un thread en cualquier sitio.
- **Navegación por hunks**, finder difuso de ficheros, editor externo y lazygit
  en popup de tmux/zellij, y **watch mode** que recarga cuando cambian el índice,
  el árbol de trabajo o el store.
- **Skills para Claude Code** (`refine-review`, `refine-resolve`) con su
  instalador, `config.example.toml`, README y LICENSE.
- Binario único con `bun run build`, con el sidecar de assets que tree-sitter
  necesita al lado.

### Corregido

- El foco de los widgets se deriva del estado después de resolver la visibilidad
  del frame; enfocar un renderable oculto es un no-op silencioso.
- Las teclas se deciden de forma síncrona: un handler `async` hace que
  `preventDefault()` llegue tarde.
- Sin wrap en ninguna fila: una fila mal medida se recorta en lugar de desplazar
  todo lo que tiene debajo.

<sub>Commits: `10ce1fa`, `b0f7486`, `099241a`, `b43f761`, `b0f81ef`, `e8fe16c`,
`9e3e5a0`, `c3f8516`, `a1edf0f`, `6d97d6d`, `a212b0c`, `d55f383`, `9ec864f`,
`b2bb2af`.</sub>
