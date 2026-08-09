# Vendored tree-sitter parsers

Regenerate with `bun run scripts/fetch-parsers.ts`; see that file for why these
are committed and where each piece comes from.

| filetype | grammar | license | wasm |
| --- | --- | --- | --- |
| `json` | tree-sitter/tree-sitter-json | MIT | 5 KB |
| `toml` | tree-sitter-grammars/tree-sitter-toml | MIT | 23 KB |
| `css` | tree-sitter/tree-sitter-css | MIT | 126 KB |
| `scss` | serenadeai/tree-sitter-scss (npm tree-sitter-scss@1.0.0) | MIT | 179 KB |
| `html` | tree-sitter/tree-sitter-html | MIT | 18 KB |
| `xml` | tree-sitter-grammars/tree-sitter-xml | MIT | 46 KB |

Highlight queries come from
[nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter)
(Apache-2.0) except HTML's and SCSS's own, which ship with their grammars (MIT).
Each `highlights.scm` records its sources in `;` headers.
