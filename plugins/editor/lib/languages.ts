/**
 * One row per editor language: the Monaco language id (which selects the
 * language service worker and editor behavior), the Shiki grammar that
 * tokenizes it (BB's own highlighter uses the same grammars, so colors match),
 * and the files it claims.
 *
 * `builtin: false` marks ids Monaco does not ship; `registerExtraLanguages`
 * registers those so a model can use them.
 */
export interface LanguageDef {
  /** Monaco language id. */
  id: string;
  /** Shiki grammar id, or null to leave the language unhighlighted. */
  grammar: string | null;
  extensions: readonly string[];
  filenames?: readonly string[];
  builtin: boolean;
}

const B = true;
const X = false;

export const LANGUAGES: readonly LanguageDef[] = [
  { id: "javascript", grammar: "javascript", extensions: ["js", "jsx", "mjs", "cjs"], builtin: B },
  { id: "typescript", grammar: "typescript", extensions: ["ts", "mts", "cts"], builtin: B },
  { id: "typescriptreact", grammar: "tsx", extensions: ["tsx"], builtin: X },
  { id: "html", grammar: "html", extensions: ["html", "htm", "xhtml"], builtin: B },
  { id: "css", grammar: "css", extensions: ["css"], builtin: B },
  { id: "scss", grammar: "scss", extensions: ["scss"], builtin: B },
  { id: "less", grammar: "less", extensions: ["less"], builtin: B },
  { id: "vue", grammar: "vue", extensions: ["vue"], builtin: X },
  { id: "svelte", grammar: "svelte", extensions: ["svelte"], builtin: X },
  { id: "astro", grammar: "astro", extensions: ["astro"], builtin: X },
  {
    id: "json",
    grammar: "json",
    extensions: ["json", "jsonc", "json5", "webmanifest", "babelrc", "eslintrc", "prettierrc"],
    filenames: [".babelrc", ".eslintrc", ".prettierrc", ".swcrc"],
    builtin: B,
  },
  { id: "yaml", grammar: "yaml", extensions: ["yaml", "yml"], filenames: [".clang-format"], builtin: B },
  { id: "toml", grammar: "toml", extensions: ["toml"], filenames: ["Cargo.lock", "Pipfile", "poetry.lock", "uv.lock"], builtin: X },
  { id: "ini", grammar: "ini", extensions: ["ini", "cfg", "conf", "properties", "editorconfig", "npmrc", "gitconfig"], filenames: [".editorconfig", ".npmrc", ".gitconfig", ".gitmodules", "setup.cfg"], builtin: B },
  { id: "dotenv", grammar: "dotenv", extensions: ["env"], filenames: [".env", ".env.local", ".env.development", ".env.production", ".env.test", ".env.example"], builtin: X },
  { id: "xml", grammar: "xml", extensions: ["xml", "xsl", "xslt", "svg", "plist", "csproj", "xaml"], builtin: B },
  { id: "csv", grammar: "csv", extensions: ["csv", "tsv"], builtin: X },
  { id: "markdown", grammar: "markdown", extensions: ["md", "markdown"], builtin: B },
  { id: "mdx", grammar: "mdx", extensions: ["mdx"], builtin: B },
  { id: "restructuredtext", grammar: "rst", extensions: ["rst"], builtin: B },
  { id: "latex", grammar: "latex", extensions: ["tex", "sty", "cls", "bib"], builtin: X },
  { id: "plaintext", grammar: null, extensions: ["txt", "text", "adoc", "lock", "gitignore", "dockerignore", "gitattributes", "npmignore", "prettierignore", "eslintignore"], filenames: [".gitignore", ".dockerignore", ".gitattributes", ".npmignore", ".prettierignore", ".eslintignore", "LICENSE", "LICENCE", "CODEOWNERS", "go.mod", "go.sum", "Procfile"], builtin: B },
  { id: "log", grammar: "log", extensions: ["log"], builtin: X },
  { id: "diff", grammar: "diff", extensions: ["diff", "patch"], builtin: X },
  { id: "git-commit", grammar: "git-commit", extensions: [], filenames: ["COMMIT_EDITMSG", "MERGE_MSG"], builtin: X },
  { id: "git-rebase", grammar: "git-rebase", extensions: [], filenames: ["git-rebase-todo"], builtin: X },
  { id: "c", grammar: "c", extensions: ["c", "h"], builtin: B },
  { id: "cpp", grammar: "cpp", extensions: ["cc", "cpp", "cxx", "c++", "hpp", "hh", "hxx", "h++", "ino"], builtin: B },
  { id: "objective-c", grammar: "objective-c", extensions: ["m", "mm"], builtin: B },
  { id: "csharp", grammar: "csharp", extensions: ["cs"], builtin: B },
  { id: "fsharp", grammar: "fsharp", extensions: ["fs", "fsi", "fsx"], builtin: B },
  { id: "rust", grammar: "rust", extensions: ["rs"], builtin: B },
  { id: "go", grammar: "go", extensions: ["go"], builtin: B },
  { id: "zig", grammar: "zig", extensions: ["zig", "zon"], builtin: X },
  { id: "swift", grammar: "swift", extensions: ["swift"], builtin: B },
  { id: "java", grammar: "java", extensions: ["java"], builtin: B },
  { id: "kotlin", grammar: "kotlin", extensions: ["kt", "kts"], builtin: B },
  { id: "scala", grammar: "scala", extensions: ["scala", "sc"], builtin: B },
  { id: "groovy", grammar: "groovy", extensions: ["groovy", "gradle"], filenames: ["Jenkinsfile"], builtin: X },
  { id: "dart", grammar: "dart", extensions: ["dart"], builtin: B },
  { id: "python", grammar: "python", extensions: ["py", "pyi", "pyw"], filenames: ["SConstruct", "SConscript"], builtin: B },
  { id: "ruby", grammar: "ruby", extensions: ["rb", "rake", "gemspec", "ru"], filenames: ["Gemfile", "Rakefile", "Podfile", "Brewfile", "Vagrantfile", "Guardfile"], builtin: B },
  { id: "php", grammar: "php", extensions: ["php", "phtml"], builtin: B },
  { id: "perl", grammar: "perl", extensions: ["pl", "pm", "t"], builtin: B },
  { id: "lua", grammar: "lua", extensions: ["lua"], builtin: B },
  { id: "r", grammar: "r", extensions: ["r", "rmd"], builtin: B },
  { id: "julia", grammar: "julia", extensions: ["jl"], builtin: B },
  { id: "elixir", grammar: "elixir", extensions: ["ex", "exs"], builtin: B },
  { id: "erlang", grammar: "erlang", extensions: ["erl", "hrl"], builtin: X },
  { id: "elm", grammar: "elm", extensions: ["elm"], builtin: X },
  { id: "gleam", grammar: "gleam", extensions: ["gleam"], builtin: X },
  { id: "haskell", grammar: "haskell", extensions: ["hs", "lhs"], builtin: X },
  { id: "ocaml", grammar: "ocaml", extensions: ["ml", "mli"], builtin: X },
  { id: "clojure", grammar: "clojure", extensions: ["clj", "cljs", "cljc", "edn"], builtin: B },
  { id: "nix", grammar: "nix", extensions: ["nix"], builtin: X },
  { id: "shell", grammar: "shellscript", extensions: ["sh", "bash", "zsh", "ksh"], filenames: [".bashrc", ".bash_profile", ".bash_aliases", ".zshrc", ".zshenv", ".zprofile", ".profile", "PKGBUILD"], builtin: B },
  { id: "fish", grammar: "fish", extensions: ["fish"], builtin: X },
  { id: "powershell", grammar: "powershell", extensions: ["ps1", "psm1", "psd1"], builtin: B },
  { id: "bat", grammar: "bat", extensions: ["bat", "cmd"], builtin: B },
  { id: "makefile", grammar: "make", extensions: ["mk", "mak"], filenames: ["Makefile", "makefile", "GNUmakefile"], builtin: X },
  { id: "cmake", grammar: "cmake", extensions: ["cmake"], filenames: ["CMakeLists.txt"], builtin: X },
  { id: "dockerfile", grammar: "docker", extensions: ["dockerfile"], filenames: ["Dockerfile", "Containerfile"], builtin: B },
  { id: "nginx", grammar: "nginx", extensions: [], filenames: ["nginx.conf"], builtin: X },
  { id: "ssh-config", grammar: "ssh-config", extensions: [], filenames: ["ssh_config", "sshd_config"], builtin: X },
  { id: "sql", grammar: "sql", extensions: ["sql", "ddl", "dml"], builtin: B },
  { id: "graphql", grammar: "graphql", extensions: ["graphql", "gql", "graphqls"], builtin: B },
  { id: "prisma", grammar: "prisma", extensions: ["prisma"], builtin: X },
  { id: "protobuf", grammar: "proto", extensions: ["proto"], builtin: B },
  { id: "hcl", grammar: "hcl", extensions: ["tf", "tfvars", "hcl", "nomad"], builtin: B },
  { id: "glsl", grammar: "glsl", extensions: ["glsl", "vert", "frag", "geom", "comp", "tesc", "tese"], builtin: X },
  { id: "wgsl", grammar: "wgsl", extensions: ["wgsl"], builtin: B },
  { id: "wasm", grammar: "wasm", extensions: ["wat"], builtin: X },
];

const BY_EXTENSION = new Map<string, LanguageDef>();
const BY_FILENAME = new Map<string, LanguageDef>();
for (const language of LANGUAGES) {
  for (const extension of language.extensions) BY_EXTENSION.set(extension, language);
  for (const filename of language.filenames ?? []) BY_FILENAME.set(filename, language);
}

const PLAINTEXT = LANGUAGES.find((language) => language.id === "plaintext")!;

/**
 * Extensions the `fileOpener` slot claims, so BB routes those files here. BB
 * accepts lowercase alphanumerics only, so `c++`-style extensions still open
 * from the Files panel but not through BB's own file links.
 */
export const CLAIMED_EXTENSIONS: readonly string[] = [...BY_EXTENSION.keys()].filter((extension) =>
  /^[a-z0-9]+$/.test(extension),
);

/** Languages Monaco does not know; `registerExtraLanguages` adds them. */
export const EXTRA_LANGUAGES: readonly LanguageDef[] = LANGUAGES.filter((language) => !language.builtin);

export function languageForPath(path: string): LanguageDef {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const byName = BY_FILENAME.get(name);
  if (byName !== undefined) return byName;
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return PLAINTEXT;
  const extension = name.slice(dotIndex + 1).toLowerCase();
  return BY_EXTENSION.get(extension) ?? PLAINTEXT;
}
