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
    ReScript,
    Regex,
    Ruby,
    Rust,
    Scala,
    Solidity,
    Sql,
    Swift,
    Tsx,
    TypeScript,
    Verilog,
    VisualBasic,
    Yaml,
}

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
        match self {
            Self::Abap => "abap",
            Self::Apex => "apex",
            Self::ArkTs => "arkts",
            Self::Astro => "astro",
            Self::Bash => "bash",
            Self::C => "c",
            Self::Clojure => "clojure",
            Self::CommonLisp => "common_lisp",
            Self::Cpp => "cpp",
            Self::CSharp => "csharp",
            Self::Css => "css",
            Self::Cuda => "cuda",
            Self::Dart => "dart",
            Self::Elixir => "elixir",
            Self::EmbeddedTemplate => "embedded_template",
            Self::Fish => "fish",
            Self::FSharp => "fsharp",
            Self::Glsl => "glsl",
            Self::Go => "go",
            Self::GraphQl => "graphql",
            Self::Groovy => "groovy",
            Self::Haskell => "haskell",
            Self::Hcl => "hcl",
            Self::Hlsl => "hlsl",
            Self::Html => "html",
            Self::Java => "java",
            Self::JavaScript => "javascript",
            Self::JsDoc => "jsdoc",
            Self::Json => "json",
            Self::Julia => "julia",
            Self::Kotlin => "kotlin",
            Self::Lean => "lean",
            Self::Lua => "lua",
            Self::Luau => "luau",
            Self::Nix => "nix",
            Self::ObjectiveC => "objc",
            Self::Ocaml => "ocaml",
            Self::OcamlInterface => "ocaml_interface",
            Self::Pascal => "pascal",
            Self::Php => "php",
            Self::PowerShell => "powershell",
            Self::Prisma => "prisma",
            Self::Python => "python",
            Self::R => "r",
            Self::ReScript => "rescript",
            Self::Regex => "regex",
            Self::Ruby => "ruby",
            Self::Rust => "rust",
            Self::Scala => "scala",
            Self::Solidity => "solidity",
            Self::Sql => "sql",
            Self::Swift => "swift",
            Self::Tsx => "tsx",
            Self::TypeScript => "typescript",
            Self::Verilog => "verilog",
            Self::VisualBasic => "vbnet",
            Self::Yaml => "yaml",
        }
    }

    /// Statically linked Tree-sitter grammar with no runtime loading or network.
    #[must_use]
    pub fn language(self) -> Language {
        match self {
            Self::Abap => tree_sitter_abap_sqry::language(),
            Self::Apex => tree_sitter_sfapex::apex::LANGUAGE.into(),
            Self::ArkTs => tree_sitter_arkts::LANGUAGE.into(),
            Self::Astro => tree_sitter_astro_next::LANGUAGE.into(),
            Self::Bash => arborium_bash::language().into(),
            Self::C => arborium_c::language().into(),
            Self::Clojure => arborium_clojure::language().into(),
            Self::CommonLisp => arborium_commonlisp::language().into(),
            Self::Cpp => arborium_cpp::language().into(),
            Self::CSharp => arborium_c_sharp::language().into(),
            Self::Css => arborium_css::language().into(),
            Self::Cuda => tree_sitter_cuda::LANGUAGE.into(),
            Self::Dart => arborium_dart::language().into(),
            Self::Elixir => arborium_elixir::language().into(),
            Self::EmbeddedTemplate => tree_sitter_embedded_template::LANGUAGE.into(),
            Self::Fish => arborium_fish::language().into(),
            Self::FSharp => arborium_fsharp::language().into(),
            Self::Glsl => arborium_glsl::language().into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
            Self::GraphQl => arborium_graphql::language().into(),
            Self::Groovy => arborium_groovy::language().into(),
            Self::Haskell => arborium_haskell::language().into(),
            Self::Hcl => arborium_hcl::language().into(),
            Self::Hlsl => arborium_hlsl::language().into(),
            Self::Html => arborium_html::language().into(),
            Self::Java => arborium_java::language().into(),
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::JsDoc => arborium_jsdoc::language().into(),
            Self::Json => arborium_json::language().into(),
            Self::Julia => arborium_julia::language().into(),
            Self::Kotlin => arborium_kotlin::language().into(),
            Self::Lean => arborium_lean::language().into(),
            Self::Lua => arborium_lua::language().into(),
            Self::Luau => tree_sitter_luau::LANGUAGE.into(),
            Self::Nix => arborium_nix::language().into(),
            Self::ObjectiveC => arborium_objc::language().into(),
            Self::Ocaml => tree_sitter_ocaml::LANGUAGE_OCAML.into(),
            Self::OcamlInterface => tree_sitter_ocaml::LANGUAGE_OCAML_INTERFACE.into(),
            Self::Pascal => tree_sitter_pascal::LANGUAGE.into(),
            Self::Php => arborium_php::language().into(),
            Self::PowerShell => arborium_powershell::language().into(),
            Self::Prisma => tree_sitter_prisma_io::LANGUAGE.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::R => arborium_r::language().into(),
            Self::ReScript => arborium_rescript::language().into(),
            Self::Regex => arborium_regex::language().into(),
            Self::Ruby => arborium_ruby::language().into(),
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::Scala => arborium_scala::language().into(),
            Self::Solidity => arborium_solidity::language().into(),
            Self::Sql => arborium_sql::language().into(),
            Self::Swift => arborium_swift::language().into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Verilog => arborium_verilog::language().into(),
            Self::VisualBasic => arborium_vb::language().into(),
            Self::Yaml => arborium_yaml::language().into(),
        }
    }

    /// Native grammar binding selected for every grammar-backed v1 mode.
    /// Twelve bounded custom languages intentionally return `None`.
    #[must_use]
    pub const fn for_source_language(language: SourceLanguage) -> Option<Self> {
        match language {
            SourceLanguage::Abap => Some(Self::Abap),
            SourceLanguage::Apex => Some(Self::Apex),
            SourceLanguage::ArkTs => Some(Self::ArkTs),
            SourceLanguage::Astro => Some(Self::Astro),
            SourceLanguage::Aura
            | SourceLanguage::Bg3Anubis
            | SourceLanguage::Bg3Resource
            | SourceLanguage::Bg3Stats => None,
            SourceLanguage::Bash | SourceLanguage::Zsh => Some(Self::Bash),
            SourceLanguage::C => Some(Self::C),
            SourceLanguage::Clojure => Some(Self::Clojure),
            SourceLanguage::CommonLisp => Some(Self::CommonLisp),
            SourceLanguage::Cpp => Some(Self::Cpp),
            SourceLanguage::CSharp => Some(Self::CSharp),
            SourceLanguage::Css => Some(Self::Css),
            SourceLanguage::Cuda => Some(Self::Cuda),
            SourceLanguage::Dart => Some(Self::Dart),
            SourceLanguage::Elixir => Some(Self::Elixir),
            SourceLanguage::EmbeddedTemplate => Some(Self::EmbeddedTemplate),
            SourceLanguage::Fish => Some(Self::Fish),
            SourceLanguage::FSharp => Some(Self::FSharp),
            SourceLanguage::Glsl => Some(Self::Glsl),
            SourceLanguage::Go => Some(Self::Go),
            SourceLanguage::GraphQl => Some(Self::GraphQl),
            SourceLanguage::Groovy => Some(Self::Groovy),
            SourceLanguage::Haskell => Some(Self::Haskell),
            SourceLanguage::Hcl => Some(Self::Hcl),
            SourceLanguage::Hlsl => Some(Self::Hlsl),
            SourceLanguage::Html => Some(Self::Html),
            SourceLanguage::Java => Some(Self::Java),
            SourceLanguage::JavaScript | SourceLanguage::Jsx => Some(Self::JavaScript),
            SourceLanguage::JsDoc => Some(Self::JsDoc),
            SourceLanguage::Json | SourceLanguage::Jupyter => Some(Self::Json),
            SourceLanguage::Julia => Some(Self::Julia),
            SourceLanguage::Khn | SourceLanguage::Lua => Some(Self::Lua),
            SourceLanguage::Kotlin => Some(Self::Kotlin),
            SourceLanguage::Lean => Some(Self::Lean),
            SourceLanguage::Liquid => None,
            SourceLanguage::Luau => Some(Self::Luau),
            SourceLanguage::Nix => Some(Self::Nix),
            SourceLanguage::ObjectiveC => Some(Self::ObjectiveC),
            SourceLanguage::Ocaml => Some(Self::Ocaml),
            SourceLanguage::OcamlInterface => Some(Self::OcamlInterface),
            SourceLanguage::Osiris => None,
            SourceLanguage::Pascal => Some(Self::Pascal),
            SourceLanguage::Php => Some(Self::Php),
            SourceLanguage::PowerShell => Some(Self::PowerShell),
            SourceLanguage::Prisma => Some(Self::Prisma),
            SourceLanguage::Properties => None,
            SourceLanguage::Python => Some(Self::Python),
            SourceLanguage::R => Some(Self::R),
            SourceLanguage::Regex => Some(Self::Regex),
            SourceLanguage::ReScript => Some(Self::ReScript),
            SourceLanguage::Ruby => Some(Self::Ruby),
            SourceLanguage::Rust => Some(Self::Rust),
            SourceLanguage::Scala => Some(Self::Scala),
            SourceLanguage::Solidity => Some(Self::Solidity),
            SourceLanguage::Sql => Some(Self::Sql),
            SourceLanguage::Svelte => None,
            SourceLanguage::Swift => Some(Self::Swift),
            SourceLanguage::Toml => None,
            SourceLanguage::Tsx => Some(Self::Tsx),
            SourceLanguage::TypeScript => Some(Self::TypeScript),
            SourceLanguage::Vb6 => None,
            SourceLanguage::VbNet => Some(Self::VisualBasic),
            SourceLanguage::Verilog => Some(Self::Verilog),
            SourceLanguage::Visualforce | SourceLanguage::Vue | SourceLanguage::Xml => None,
            SourceLanguage::Yaml => Some(Self::Yaml),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_admitted_native_grammar_is_unique_sorted_and_abi_compatible() {
        let ids = NativeGrammar::ALL.map(NativeGrammar::stable_id);
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
        for grammar in NativeGrammar::ALL {
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

        for language in SourceLanguage::ALL {
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
