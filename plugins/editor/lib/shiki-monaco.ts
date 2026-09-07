/**
 * Tokenizes Monaco models with Shiki's TextMate grammars and paints them with
 * BB's current VS Code theme document, so the editor's colors are the ones
 * BB's own code renderer produces.
 *
 * Monaco tokens carry one scope string each, and a Monaco theme colors a scope
 * through its rule table. Shiki resolves the winning color for a token; this
 * adapter hands Monaco a scope from the current theme's rules that carries
 * that same color and font style, which Monaco then paints identically. The
 * approach is `@shikijs/monaco`'s; this version supports theme switches and
 * grammars that load after the first editor opens.
 */
import type * as MonacoNs from "monaco-editor";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import type { EditorBundle } from "./monaco-loader.js";
import type { LanguageDef } from "./languages.js";
import type { BbTokens } from "./bb-tokens.js";
import { monacoThemeName, normalizeFontStyle, normalizeHex, themeFingerprint, toMonacoTheme } from "./monaco-theme.js";

type Highlighter = Awaited<ReturnType<EditorBundle["createHighlighterCore"]>>;
type StateStack = Parameters<ReturnType<Highlighter["getLanguage"]>["tokenizeLine2"]>[1];

const MAX_TOKENIZED_LINE_LENGTH = 20_000;
const TOKENIZE_TIME_LIMIT_MS = 500;

class TokenizerState implements MonacoNs.languages.IState {
  constructor(readonly ruleStack: StateStack) {}
  clone(): TokenizerState {
    return new TokenizerState(this.ruleStack);
  }
  equals(other: MonacoNs.languages.IState): boolean {
    return other instanceof TokenizerState && other.ruleStack === this.ruleStack;
  }
}

function fontStyleBits(bundle: EditorBundle, fontStyle: number): string {
  const { FontStyle } = bundle;
  if (fontStyle <= FontStyle.None) return "";
  const styles: string[] = [];
  if (fontStyle & FontStyle.Italic) styles.push("italic");
  if (fontStyle & FontStyle.Bold) styles.push("bold");
  if (fontStyle & FontStyle.Underline) styles.push("underline");
  if (fontStyle & FontStyle.Strikethrough) styles.push("strikethrough");
  return styles.join(" ");
}

export class ShikiTokenization {
  private colorMap: string[] = [];
  /** Scope of the first theme rule with a given color, and color + font style. */
  private readonly scopeByColor = new Map<string, string>();
  private readonly scopeByColorStyle = new Map<string, string>();
  private readonly providers = new Map<string, MonacoNs.IDisposable>();
  private readonly grammarLoads = new Map<string, Promise<void>>();
  private themeName: string | null = null;

  private constructor(
    private readonly bundle: EditorBundle,
    private readonly monaco: typeof MonacoNs,
    private readonly highlighter: Highlighter,
  ) {}

  static async create(bundle: EditorBundle, monaco: typeof MonacoNs): Promise<ShikiTokenization> {
    const highlighter = await bundle.createHighlighterCore({
      themes: [],
      langs: [],
      engine: bundle.createOnigurumaEngine(bundle.loadOnigurumaWasm()),
    });
    return new ShikiTokenization(bundle, monaco, highlighter);
  }

  /**
   * Registers `theme` with Shiki (once per document content) and (re)defines
   * the Monaco theme with BB's current surface tokens, then makes it current.
   * Returns the Monaco theme name to pass to `setTheme`.
   */
  async applyTheme(theme: PluginCodeThemeData, tokens: BbTokens | null): Promise<string> {
    const name = monacoThemeName(`${theme.name}-${themeFingerprint(theme)}`);
    const loaded = this.highlighter.getLoadedThemes().includes(name);
    if (!loaded) {
      // Shiki's raw theme shape is VS Code's: `settings` is the pre-1.0 name of
      // `tokenColors`, and it normalizes the rest itself.
      await this.highlighter.loadTheme({
        name,
        type: theme.type,
        fg: theme.fg,
        bg: theme.bg,
        colors: { ...theme.colors },
        settings: theme.tokenColors.map((rule) => ({
          ...(rule.scope === undefined ? {} : { scope: [...(typeof rule.scope === "string" ? [rule.scope] : rule.scope)] }),
          settings: { ...rule.settings },
        })),
      });
    }
    // Chrome colors follow BB's palette, which can change without the code
    // theme changing, so the Monaco theme is rebuilt on every apply.
    this.monaco.editor.defineTheme(name, toMonacoTheme(theme, tokens));
    if (this.themeName === name) return name;
    this.themeName = name;
    const { colorMap } = this.highlighter.setTheme(name);
    this.colorMap = colorMap;
    this.scopeByColor.clear();
    this.scopeByColorStyle.clear();
    for (const rule of theme.tokenColors) {
      const color = normalizeHex(rule.settings.foreground);
      if (color === undefined) continue;
      const scopes =
        rule.scope === undefined ? [] : typeof rule.scope === "string" ? rule.scope.split(",") : rule.scope;
      const scope = scopes.map((entry) => entry.trim()).find((entry) => entry !== "");
      if (scope === undefined) continue;
      const style = normalizeFontStyle(rule.settings.fontStyle) ?? "";
      if (!this.scopeByColorStyle.has(colorStyleKey(color, style))) {
        this.scopeByColorStyle.set(colorStyleKey(color, style), scope);
      }
      if (style === "" && !this.scopeByColor.has(color)) this.scopeByColor.set(color, scope);
    }
    // Tokens already on screen carry scopes chosen for the previous theme;
    // re-registering each provider makes Monaco tokenize those models again.
    for (const languageId of [...this.providers.keys()]) this.registerProvider(languageId);
    return name;
  }

  /** Loads the grammar for `language` (once) and tokenizes its models with it. */
  async ensureLanguage(language: LanguageDef): Promise<void> {
    const grammar = language.grammar;
    if (grammar === null || this.providers.has(language.id)) return;
    if (!this.highlighter.getLoadedLanguages().includes(grammar)) {
      let load = this.grammarLoads.get(grammar);
      if (load === undefined) {
        const loader = this.bundle.grammars[grammar];
        if (loader === undefined) return;
        load = loader().then((module) => this.highlighter.loadLanguage(module.default));
        this.grammarLoads.set(grammar, load);
      }
      await load;
    }
    if (!this.providers.has(language.id)) {
      this.grammarByLanguage.set(language.id, grammar);
      this.registerProvider(language.id);
    }
  }

  private readonly grammarByLanguage = new Map<string, string>();

  private registerProvider(languageId: string): void {
    const grammarId = this.grammarByLanguage.get(languageId);
    if (grammarId === undefined) return;
    const previous = this.providers.get(languageId);
    this.providers.set(languageId, this.monaco.languages.setTokensProvider(languageId, this.provider(grammarId)));
    previous?.dispose();
  }

  private provider(grammarId: string): MonacoNs.languages.TokensProvider {
    const { EncodedTokenMetadata, INITIAL } = this.bundle;
    return {
      getInitialState: () => new TokenizerState(INITIAL),
      tokenize: (line, state) => {
        const stack = state instanceof TokenizerState ? state.ruleStack : INITIAL;
        if (line.length >= MAX_TOKENIZED_LINE_LENGTH) {
          return { endState: new TokenizerState(stack), tokens: [{ startIndex: 0, scopes: "" }] };
        }
        const grammar = this.highlighter.getLanguage(grammarId);
        const result = grammar.tokenizeLine2(line, stack, TOKENIZE_TIME_LIMIT_MS);
        const tokens: MonacoNs.languages.IToken[] = [];
        for (let i = 0; i < result.tokens.length; i += 2) {
          const metadata = result.tokens[i + 1]!;
          const color = normalizeHex(this.colorMap[EncodedTokenMetadata.getForeground(metadata)]);
          const style = fontStyleBits(this.bundle, EncodedTokenMetadata.getFontStyle(metadata));
          // A token's style can combine several rules (italic from a parent
          // scope, color from a child); prefer an exact match, then keep the
          // color and drop the style.
          const scope =
            color === undefined
              ? ""
              : (this.scopeByColorStyle.get(colorStyleKey(color, style)) ?? this.scopeByColor.get(color) ?? "");
          tokens.push({ startIndex: result.tokens[i]!, scopes: scope });
        }
        return { endState: new TokenizerState(result.ruleStack), tokens };
      },
    };
  }
}

function colorStyleKey(color: string, fontStyle: string): string {
  return fontStyle === "" ? color : `${color}|${fontStyle}`;
}
