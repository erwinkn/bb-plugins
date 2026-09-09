/**
 * The files this editor opens: one row per file type, with the Shiki grammar
 * Pierre highlights it with (BB's own highlighter uses the same grammars, so
 * colors match) and the extensions it claims. Pierre picks the grammar from
 * the file name itself; this table exists so BB routes these files to the
 * plugin's opener, and so a test can prove every grammar ships.
 */
export interface FileType {
  /** Shiki grammar id, or null for a file type shown as plain text. */
  grammar: string | null;
  extensions: readonly string[];
}

export const FILE_TYPES: readonly FileType[] = [
  { grammar: "javascript", extensions: ["js", "jsx", "mjs", "cjs"] },
  { grammar: "typescript", extensions: ["ts", "mts", "cts"] },
  { grammar: "tsx", extensions: ["tsx"] },
  { grammar: "html", extensions: ["html", "htm", "xhtml"] },
  { grammar: "css", extensions: ["css"] },
  { grammar: "scss", extensions: ["scss"] },
  { grammar: "less", extensions: ["less"] },
  { grammar: "vue", extensions: ["vue"] },
  { grammar: "svelte", extensions: ["svelte"] },
  { grammar: "astro", extensions: ["astro"] },
  { grammar: "yaml", extensions: ["yaml", "yml"] },
  { grammar: "toml", extensions: ["toml"] },
  { grammar: "ini", extensions: ["ini", "cfg", "conf", "properties", "editorconfig", "npmrc", "gitconfig"] },
  { grammar: "dotenv", extensions: ["env"] },
  { grammar: "xml", extensions: ["xml", "xsl", "xslt", "svg", "plist", "csproj", "xaml"] },
  { grammar: "csv", extensions: ["csv", "tsv"] },
  { grammar: "markdown", extensions: ["md", "markdown"] },
  { grammar: "mdx", extensions: ["mdx"] },
  { grammar: "rst", extensions: ["rst"] },
  { grammar: "latex", extensions: ["tex", "sty", "cls", "bib"] },
  { grammar: null, extensions: ["txt", "text", "adoc", "lock", "gitignore", "dockerignore", "gitattributes", "npmignore", "prettierignore", "eslintignore"] },
  { grammar: "log", extensions: ["log"] },
  { grammar: "diff", extensions: ["diff", "patch"] },
  { grammar: "c", extensions: ["c", "h"] },
  { grammar: "cpp", extensions: ["cc", "cpp", "cxx", "c++", "hpp", "hh", "hxx", "h++", "ino"] },
  { grammar: "objective-c", extensions: ["m", "mm"] },
  { grammar: "csharp", extensions: ["cs"] },
  { grammar: "fsharp", extensions: ["fs", "fsi", "fsx"] },
  { grammar: "rust", extensions: ["rs"] },
  { grammar: "go", extensions: ["go"] },
  { grammar: "zig", extensions: ["zig", "zon"] },
  { grammar: "swift", extensions: ["swift"] },
  { grammar: "java", extensions: ["java"] },
  { grammar: "kotlin", extensions: ["kt", "kts"] },
  { grammar: "scala", extensions: ["scala", "sc"] },
  { grammar: "groovy", extensions: ["groovy", "gradle"] },
  { grammar: "dart", extensions: ["dart"] },
  { grammar: "python", extensions: ["py", "pyi", "pyw"] },
  { grammar: "ruby", extensions: ["rb", "rake", "gemspec", "ru"] },
  { grammar: "php", extensions: ["php", "phtml"] },
  { grammar: "perl", extensions: ["pl", "pm", "t"] },
  { grammar: "lua", extensions: ["lua"] },
  { grammar: "r", extensions: ["r", "rmd"] },
  { grammar: "julia", extensions: ["jl"] },
  { grammar: "elixir", extensions: ["ex", "exs"] },
  { grammar: "erlang", extensions: ["erl", "hrl"] },
  { grammar: "elm", extensions: ["elm"] },
  { grammar: "gleam", extensions: ["gleam"] },
  { grammar: "haskell", extensions: ["hs", "lhs"] },
  { grammar: "ocaml", extensions: ["ml", "mli"] },
  { grammar: "clojure", extensions: ["clj", "cljs", "cljc", "edn"] },
  { grammar: "nix", extensions: ["nix"] },
  { grammar: "shellscript", extensions: ["sh", "bash", "zsh", "ksh"] },
  { grammar: "fish", extensions: ["fish"] },
  { grammar: "powershell", extensions: ["ps1", "psm1", "psd1"] },
  { grammar: "bat", extensions: ["bat", "cmd"] },
  { grammar: "make", extensions: ["mk", "mak"] },
  { grammar: "cmake", extensions: ["cmake"] },
  { grammar: "docker", extensions: ["dockerfile"] },
  { grammar: "sql", extensions: ["sql", "ddl", "dml"] },
  { grammar: "graphql", extensions: ["graphql", "gql", "graphqls"] },
  { grammar: "prisma", extensions: ["prisma"] },
  { grammar: "proto", extensions: ["proto"] },
  { grammar: "hcl", extensions: ["tf", "tfvars", "hcl", "nomad"] },
  { grammar: "glsl", extensions: ["glsl", "vert", "frag", "geom", "comp", "tesc", "tese"] },
  { grammar: "wgsl", extensions: ["wgsl"] },
  { grammar: "wasm", extensions: ["wat"] },
];

/**
 * Extensions the `fileOpener` slot claims, so BB routes those files here. BB
 * accepts lowercase alphanumerics only, so `c++`-style extensions still open
 * from the Files panel but not through BB's own file links.
 */
export const CLAIMED_EXTENSIONS: readonly string[] = [...new Set(FILE_TYPES.flatMap((type) => type.extensions))].filter(
  (extension) => /^[a-z0-9]+$/.test(extension),
);
