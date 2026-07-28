use cartograph_domain::SourceLanguage;
use tree_sitter::Language;

/// Exact-pinned native grammar bindings admitted for the v1 parity program.
///
/// A grammar in this registry proves only that its parser is linked and ABI
/// compatible. Public language support is granted separately, after the
/// language's structural/custom extractor and black-box corpus pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum NativeGrammar {
    Abap,
    Apex,
    ArkTs,
    Astro,
    Bash,
    C,
    Clojure,
    CommonLisp,
    Cpp,
    CSharp,
    Css,
    Cuda,
    Dart,
    Elixir,
    EmbeddedTemplate,
    Fish,
    FSharp,
    Glsl,
    Go,
    GraphQl,
    Groovy,
    Haskell,
    Hcl,
    Hlsl,
    Html,
    Java,
    JavaScript,
    JsDoc,
    Json,
    Julia,
    Kotlin,
    Lean,
    Lua,
    Luau,
    Nix,
    ObjectiveC,
    Ocaml,
    OcamlInterface,
    Pascal,
    Php,
    PowerShell,
    Prisma,
    Python,
    R,
    Regex,
    ReScript,
    Ruby,
    Rust,
    Scala,
    Solidity,
    Sql,
    Swift,
    Tsx,
    TypeScript,
    VisualBasic,
    Verilog,
    Yaml,
}

const NATIVE_GRAMMAR_IDS: [&str; 57] = [
    "abap",
    "apex",
    "arkts",
    "astro",
    "bash",
    "c",
    "clojure",
    "common_lisp",
    "cpp",
    "csharp",
    "css",
    "cuda",
    "dart",
    "elixir",
    "embedded_template",
    "fish",
    "fsharp",
    "glsl",
    "go",
    "graphql",
    "groovy",
    "haskell",
    "hcl",
    "hlsl",
    "html",
    "java",
    "javascript",
    "jsdoc",
    "json",
    "julia",
    "kotlin",
    "lean",
    "lua",
    "luau",
    "nix",
    "objc",
    "ocaml",
    "ocaml_interface",
    "pascal",
    "php",
    "powershell",
    "prisma",
    "python",
    "r",
    "regex",
    "rescript",
    "ruby",
    "rust",
    "scala",
    "solidity",
    "sql",
    "swift",
    "tsx",
    "typescript",
    "vbnet",
    "verilog",
    "yaml",
];

const NATIVE_GRAMMAR_FACTORIES: [fn() -> Language; 57] = [
    || tree_sitter_abap_sqry::language(),
    || tree_sitter_sfapex::apex::LANGUAGE.into(),
    || tree_sitter_arkts::LANGUAGE.into(),
    || tree_sitter_astro_next::LANGUAGE.into(),
    || arborium_bash::language().into(),
    || arborium_c::language().into(),
    || arborium_clojure::language().into(),
    || arborium_commonlisp::language().into(),
    || arborium_cpp::language().into(),
    || arborium_c_sharp::language().into(),
    || arborium_css::language().into(),
    || tree_sitter_cuda::LANGUAGE.into(),
    || arborium_dart::language().into(),
    || arborium_elixir::language().into(),
    || tree_sitter_embedded_template::LANGUAGE.into(),
    || arborium_fish::language().into(),
    || arborium_fsharp::language().into(),
    || arborium_glsl::language().into(),
    || tree_sitter_go::LANGUAGE.into(),
    || arborium_graphql::language().into(),
    || arborium_groovy::language().into(),
    || arborium_haskell::language().into(),
    || arborium_hcl::language().into(),
    || arborium_hlsl::language().into(),
    || arborium_html::language().into(),
    || arborium_java::language().into(),
    || tree_sitter_javascript::LANGUAGE.into(),
    || arborium_jsdoc::language().into(),
    || arborium_json::language().into(),
    || arborium_julia::language().into(),
    || arborium_kotlin::language().into(),
    || arborium_lean::language().into(),
    || arborium_lua::language().into(),
    || tree_sitter_luau::LANGUAGE.into(),
    || arborium_nix::language().into(),
    || arborium_objc::language().into(),
    || tree_sitter_ocaml::LANGUAGE_OCAML.into(),
    || tree_sitter_ocaml::LANGUAGE_OCAML_INTERFACE.into(),
    || tree_sitter_pascal::LANGUAGE.into(),
    || arborium_php::language().into(),
    || arborium_powershell::language().into(),
    || tree_sitter_prisma_io::LANGUAGE.into(),
    || tree_sitter_python::LANGUAGE.into(),
    || arborium_r::language().into(),
    || arborium_regex::language().into(),
    || arborium_rescript::language().into(),
    || arborium_ruby::language().into(),
    || tree_sitter_rust::LANGUAGE.into(),
    || arborium_scala::language().into(),
    || arborium_solidity::language().into(),
    || arborium_sql::language().into(),
    || arborium_swift::language().into(),
    || tree_sitter_typescript::LANGUAGE_TSX.into(),
    || tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
    || arborium_vb::language().into(),
    || arborium_verilog::language().into(),
    || arborium_yaml::language().into(),
];

const SOURCE_LANGUAGE_GRAMMARS: [Option<NativeGrammar>; 74] = [
    Some(NativeGrammar::Abap),
    Some(NativeGrammar::Apex),
    Some(NativeGrammar::ArkTs),
    Some(NativeGrammar::Astro),
    None,
    Some(NativeGrammar::Bash),
    None,
    None,
    None,
    Some(NativeGrammar::C),
    Some(NativeGrammar::Clojure),
    Some(NativeGrammar::CommonLisp),
    Some(NativeGrammar::Cpp),
    Some(NativeGrammar::CSharp),
    Some(NativeGrammar::Css),
    Some(NativeGrammar::Cuda),
    Some(NativeGrammar::Dart),
    Some(NativeGrammar::Elixir),
    Some(NativeGrammar::EmbeddedTemplate),
    Some(NativeGrammar::Fish),
    Some(NativeGrammar::FSharp),
    Some(NativeGrammar::Glsl),
    Some(NativeGrammar::Go),
    Some(NativeGrammar::GraphQl),
    Some(NativeGrammar::Groovy),
    Some(NativeGrammar::Haskell),
    Some(NativeGrammar::Hcl),
    Some(NativeGrammar::Hlsl),
    Some(NativeGrammar::Html),
    Some(NativeGrammar::Java),
    Some(NativeGrammar::JavaScript),
    Some(NativeGrammar::JsDoc),
    Some(NativeGrammar::Json),
    Some(NativeGrammar::JavaScript),
    Some(NativeGrammar::Julia),
    Some(NativeGrammar::Json),
    Some(NativeGrammar::Lua),
    Some(NativeGrammar::Kotlin),
    Some(NativeGrammar::Lean),
    None,
    Some(NativeGrammar::Lua),
    Some(NativeGrammar::Luau),
    Some(NativeGrammar::Nix),
    Some(NativeGrammar::ObjectiveC),
    Some(NativeGrammar::Ocaml),
    Some(NativeGrammar::OcamlInterface),
    None,
    Some(NativeGrammar::Pascal),
    Some(NativeGrammar::Php),
    Some(NativeGrammar::PowerShell),
    Some(NativeGrammar::Prisma),
    None,
    Some(NativeGrammar::Python),
    Some(NativeGrammar::R),
    Some(NativeGrammar::Regex),
    Some(NativeGrammar::ReScript),
    Some(NativeGrammar::Ruby),
    Some(NativeGrammar::Rust),
    Some(NativeGrammar::Scala),
    Some(NativeGrammar::Solidity),
    Some(NativeGrammar::Sql),
    None,
    Some(NativeGrammar::Swift),
    None,
    Some(NativeGrammar::Tsx),
    Some(NativeGrammar::TypeScript),
    None,
    Some(NativeGrammar::VisualBasic),
    Some(NativeGrammar::Verilog),
    None,
    None,
    None,
    Some(NativeGrammar::Yaml),
    Some(NativeGrammar::Bash),
];

impl NativeGrammar {
    /// Every admitted binding in stable language-id order.
    pub const ALL: [Self; 57] = [
        Self::Abap,
        Self::Apex,
        Self::ArkTs,
        Self::Astro,
        Self::Bash,
        Self::C,
        Self::Clojure,
        Self::CommonLisp,
        Self::Cpp,
        Self::CSharp,
        Self::Css,
        Self::Cuda,
        Self::Dart,
        Self::Elixir,
        Self::EmbeddedTemplate,
        Self::Fish,
        Self::FSharp,
        Self::Glsl,
        Self::Go,
        Self::GraphQl,
        Self::Groovy,
        Self::Haskell,
        Self::Hcl,
        Self::Hlsl,
        Self::Html,
        Self::Java,
        Self::JavaScript,
        Self::JsDoc,
        Self::Json,
        Self::Julia,
        Self::Kotlin,
        Self::Lean,
        Self::Lua,
        Self::Luau,
        Self::Nix,
        Self::ObjectiveC,
        Self::Ocaml,
        Self::OcamlInterface,
        Self::Pascal,
        Self::Php,
        Self::PowerShell,
        Self::Prisma,
        Self::Python,
        Self::R,
        Self::Regex,
        Self::ReScript,
        Self::Ruby,
        Self::Rust,
        Self::Scala,
        Self::Solidity,
        Self::Sql,
        Self::Swift,
        Self::Tsx,
        Self::TypeScript,
        Self::VisualBasic,
        Self::Verilog,
        Self::Yaml,
    ];

    /// Stable v1 storage/protocol language id represented by this binding.
    #[must_use]
    pub const fn stable_id(self) -> &'static str {
        NATIVE_GRAMMAR_IDS[self as usize]
    }

    /// Statically linked Tree-sitter grammar with no runtime loading or network.
    #[must_use]
    pub fn language(self) -> Language {
        NATIVE_GRAMMAR_FACTORIES[self as usize]()
    }

    /// Native grammar binding selected for every grammar-backed v1 mode.
    /// Twelve bounded custom languages intentionally return `None`.
    #[must_use]
    pub const fn for_source_language(language: SourceLanguage) -> Option<Self> {
        SOURCE_LANGUAGE_GRAMMARS[language as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_admitted_native_grammar_is_unique_sorted_and_abi_compatible() {
        let ids = NativeGrammar::ALL.map(NativeGrammar::stable_id);
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
        for (ordinal, grammar) in NativeGrammar::ALL.into_iter().enumerate() {
            assert_eq!(grammar as usize, ordinal, "grammar registry order drifted");
            let mut parser = tree_sitter::Parser::new();
            parser
                .set_language(&grammar.language())
                .unwrap_or_else(|error| {
                    panic!("{} grammar is incompatible: {error}", grammar.stable_id())
                });
        }
    }

    #[test]
    fn grammar_mapping_covers_exact_v1_grammar_and_custom_counts() {
        let v1_languages = SourceLanguage::ALL
            .into_iter()
            .filter(|language| language.is_v1_language())
            .collect::<Vec<_>>();
        let grammar_backed = v1_languages
            .iter()
            .copied()
            .filter(|language| NativeGrammar::for_source_language(*language).is_some())
            .count();
        assert_eq!(grammar_backed, 61);
        assert_eq!(v1_languages.len() - grammar_backed, 12);
        assert_eq!(
            NativeGrammar::for_source_language(SourceLanguage::Toml),
            None
        );

        for (ordinal, language) in SourceLanguage::ALL.into_iter().enumerate() {
            assert_eq!(
                language as usize, ordinal,
                "language registry order drifted"
            );
            let spec = crate::LanguageSpec::for_language(language);
            assert_eq!(
                NativeGrammar::for_source_language(language).is_some(),
                spec.strategy() != crate::ExtractionStrategy::CustomStructural,
                "{} grammar/custom routing drifted",
                language.as_str()
            );
        }
    }
}
