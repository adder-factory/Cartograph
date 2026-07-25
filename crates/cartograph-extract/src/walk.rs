use std::collections::{BTreeSet, HashMap};

use cartograph_domain::{
    FileParseStatus, ReferenceKind, SourceLanguage, SymbolId, SymbolKind, Visibility,
    declaration_value_is_search_safe,
};
use tree_sitter::Node;

use crate::{
    Containment, DiagnosticCode, ExtractError, ExtractedFile, ExtractedImportBinding,
    ExtractedReference, ExtractedSymbol, ExtractionDiagnostic, ExtractionStrategy, LanguageSpec,
    SourceSnapshot,
    budget::{
        ExtractionBudget, containment_budget_bytes, diagnostic_budget_bytes,
        import_binding_budget_bytes, reference_budget_bytes, symbol_budget_bytes,
    },
    identity::SymbolIdentity,
};

mod c_family;
mod declarations;
mod dynamic_dispatch;
mod embedded_sql;
mod generic_family;
mod graphql_family;
mod jvm_dynamic_family;
mod managed_family;
mod module_system;
mod polyglot;
mod prisma_family;
mod references;
mod schema;
mod shell_family;
mod sql_family;
pub(crate) mod syntax;
mod value_references;

use syntax::{
    body_search_text, callable_signature, clone_token_profile, collect_diagnostics, contains_jsx,
    export_flags, has_child_kind, jsdoc, named_children, span_for, starts_uppercase,
    structural_digest, visibility,
};

const MAX_AST_DEPTH: usize = 256;

pub(crate) struct WalkInput<'tree> {
    root: Node<'tree>,
    parse_status: FileParseStatus,
}

impl<'tree> WalkInput<'tree> {
    pub(crate) const fn new(root: Node<'tree>, parse_status: FileParseStatus) -> Self {
        Self { root, parse_status }
    }
}

pub(crate) fn extract(
    snapshot: &SourceSnapshot,
    input: WalkInput<'_>,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<ExtractedFile, ExtractError> {
    let strategy = LanguageSpec::for_language(snapshot.language()).strategy();
    if !strategy.is_executable() {
        return Err(ExtractError::UnsupportedLanguage);
    }
    let mut builder = ExtractionBuilder::new(snapshot, cancelled)?;
    if strategy != ExtractionStrategy::ParserOnly {
        module_system::collect_explicit_exports(&mut builder, input.root)?;
        builder.visit(input.root, 0)?;
        dynamic_dispatch::enrich(&mut builder, input.root)?;
        schema::enrich(&mut builder, input.root)?;
        embedded_sql::enrich(&mut builder, input.root)?;
        value_references::enrich(&mut builder, input.root)?;
    }
    let diagnostics = if input.parse_status == FileParseStatus::Partial {
        let diagnostics = collect_diagnostics(input.root, builder.context.cancelled)?;
        if diagnostics.is_empty() {
            vec![ExtractionDiagnostic {
                code: DiagnosticCode::SyntaxError,
                span: None,
            }]
        } else {
            diagnostics
        }
    } else {
        Vec::new()
    };
    for _ in &diagnostics {
        builder
            .context
            .budget
            .reserve_fact(diagnostic_budget_bytes(), std::iter::empty())?;
    }
    let output_limit = builder.context.budget.output_limit();
    let has_inline_tests = has_inline_tests(
        snapshot.language(),
        input.root,
        snapshot.source(),
        builder.context.cancelled,
    )?;
    let file = ExtractedFile {
        file_id: snapshot.file_id().clone(),
        path: snapshot.path().clone(),
        language: snapshot.language(),
        content_hash: snapshot.content_hash().clone(),
        byte_size: snapshot.byte_size(),
        line_count: snapshot.line_count(),
        parse_status: input.parse_status,
        symbols: builder.facts.symbols,
        containments: builder.facts.containments,
        references: builder.facts.references,
        import_bindings: builder.facts.import_bindings,
        has_inline_tests,
        test_search_text: String::new(),
        test_search_truncated: false,
        diagnostics,
    };
    if file.modeled_retained_bytes() > output_limit {
        return Err(ExtractError::OutputLimit);
    }
    Ok(file)
}

fn has_inline_tests(
    language: SourceLanguage,
    root: Node<'_>,
    source: &str,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<bool, ExtractError> {
    if language != SourceLanguage::Rust {
        return Ok(false);
    }
    for node in syntax::descendants_including_root(root) {
        if cancelled() {
            return Err(ExtractError::Cancelled);
        }
        if node.kind() != "attribute_item" || !rust_attribute_precedes_function(node) {
            continue;
        }
        let attribute = source
            .get(node.start_byte()..node.end_byte())
            .ok_or(ExtractError::InvalidSpan)?;
        let mut compact = String::new();
        compact
            .try_reserve(attribute.len())
            .map_err(|_| ExtractError::OutputLimit)?;
        compact.extend(
            attribute
                .chars()
                .filter(|character| !character.is_whitespace()),
        );
        if matches!(compact.as_str(), "#[test]" | "#[rstest]")
            || compact.starts_with("#[tokio::test")
            || compact.starts_with("#[async_std::test")
            || compact.starts_with("#[actix_rt::test")
            || compact.starts_with("#[test_case")
            || compact.starts_with("#[rstest(")
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn rust_attribute_precedes_function(node: Node<'_>) -> bool {
    let mut sibling = node.next_named_sibling();
    for _ in 0..16 {
        let Some(candidate) = sibling else {
            return false;
        };
        match candidate.kind() {
            "function_item" => return true,
            "attribute_item" => sibling = candidate.next_named_sibling(),
            _ => return false,
        }
    }
    false
}

struct ExtractionBuilder<'source, 'cancel> {
    context: ExtractionContext<'source, 'cancel>,
    identities: SymbolIdentity<'source>,
    facts: ExtractionFacts,
    owners: Vec<SymbolId>,
    native_owner_kinds: Vec<SymbolKind>,
    native_visibilities: Vec<Option<Visibility>>,
    native_scope_symbols: HashMap<String, Option<(SymbolId, SymbolKind)>>,
    qualifiers: Vec<String>,
    explicit_exports: BTreeSet<String>,
    explicit_default_exports: BTreeSet<String>,
    commonjs_shadowing: module_system::CommonJsShadowing,
}

struct ExtractionContext<'source, 'cancel> {
    snapshot: &'source SourceSnapshot,
    cancelled: &'cancel mut dyn FnMut() -> bool,
    budget: ExtractionBudget,
}

#[derive(Default)]
struct ExtractionFacts {
    symbols: Vec<ExtractedSymbol>,
    containments: Vec<Containment>,
    references: Vec<ExtractedReference>,
    import_bindings: Vec<ExtractedImportBinding>,
}

struct PendingSymbol<'tree> {
    kind: SymbolKind,
    name: String,
    span_node: Node<'tree>,
    structural_node: Node<'tree>,
    doc_anchor: Node<'tree>,
    body_node: Option<Node<'tree>>,
    declaration_only: bool,
    signature: Option<String>,
    exported: bool,
    default_export: bool,
    async_symbol: bool,
    static_member: bool,
    visibility: Option<Visibility>,
}

pub(super) struct PendingReference<'tree> {
    owner: Option<SymbolId>,
    name: String,
    kind: ReferenceKind,
    node: Node<'tree>,
}

impl<'source, 'cancel> ExtractionBuilder<'source, 'cancel> {
    fn new(
        snapshot: &'source SourceSnapshot,
        cancelled: &'cancel mut dyn FnMut() -> bool,
    ) -> Result<Self, ExtractError> {
        Ok(Self {
            context: ExtractionContext::new(snapshot, cancelled)?,
            identities: SymbolIdentity::new(snapshot.path()),
            facts: ExtractionFacts::default(),
            owners: Vec::new(),
            native_owner_kinds: Vec::new(),
            native_visibilities: Vec::new(),
            native_scope_symbols: HashMap::new(),
            qualifiers: Vec::new(),
            explicit_exports: BTreeSet::new(),
            explicit_default_exports: BTreeSet::new(),
            commonjs_shadowing: module_system::CommonJsShadowing::default(),
        })
    }

    fn visit(&mut self, node: Node<'_>, depth: usize) -> Result<(), ExtractError> {
        self.context.ensure_active()?;
        if depth > MAX_AST_DEPTH {
            return Err(ExtractError::NestingLimit);
        }
        if self.visit_declaration(node, depth)? {
            return Ok(());
        }
        self.visit_usage(node, depth)
    }

    fn visit_declaration(&mut self, node: Node<'_>, depth: usize) -> Result<bool, ExtractError> {
        match self.context.snapshot.language() {
            SourceLanguage::Bash
            | SourceLanguage::Fish
            | SourceLanguage::PowerShell
            | SourceLanguage::Zsh => return shell_family::visit_declaration(self, node, depth),
            SourceLanguage::C
            | SourceLanguage::Cpp
            | SourceLanguage::Cuda
            | SourceLanguage::Glsl
            | SourceLanguage::Hlsl => return c_family::visit_declaration(self, node, depth),
            SourceLanguage::Java | SourceLanguage::CSharp => {
                return managed_family::visit_declaration(self, node, depth);
            }
            SourceLanguage::Kotlin | SourceLanguage::Scala | SourceLanguage::Groovy => {
                return jvm_dynamic_family::visit_declaration(self, node, depth);
            }
            SourceLanguage::GraphQl => {
                return graphql_family::visit_declaration(self, node, depth);
            }
            SourceLanguage::Prisma => {
                return prisma_family::visit_declaration(self, node, depth);
            }
            SourceLanguage::Sql => {
                return sql_family::visit_declaration(self, node, depth);
            }
            SourceLanguage::Abap
            | SourceLanguage::Apex
            | SourceLanguage::ArkTs
            | SourceLanguage::Astro
            | SourceLanguage::Clojure
            | SourceLanguage::CommonLisp
            | SourceLanguage::Dart
            | SourceLanguage::FSharp
            | SourceLanguage::Hcl
            | SourceLanguage::Html
            | SourceLanguage::Khn
            | SourceLanguage::Lean
            | SourceLanguage::Lua
            | SourceLanguage::Luau
            | SourceLanguage::Nix
            | SourceLanguage::ObjectiveC
            | SourceLanguage::Pascal
            | SourceLanguage::Php
            | SourceLanguage::R
            | SourceLanguage::ReScript
            | SourceLanguage::Ruby
            | SourceLanguage::Solidity
            | SourceLanguage::Swift
            | SourceLanguage::VbNet
            | SourceLanguage::Yaml => {
                return generic_family::visit_declaration(self, node, depth);
            }
            SourceLanguage::Rust | SourceLanguage::Python | SourceLanguage::Go => {
                return polyglot::visit_declaration(self, node, depth);
            }
            SourceLanguage::TypeScript
            | SourceLanguage::Tsx
            | SourceLanguage::JavaScript
            | SourceLanguage::Jsx => {}
            _ => return Err(ExtractError::UnsupportedLanguage),
        }
        match node.kind() {
            "interface_declaration" | "class_declaration" | "abstract_class_declaration" => {
                self.visit_container(node, depth)?;
            }
            "function_declaration"
            | "generator_function_declaration"
            | "function_signature"
            | "method_definition"
            | "method_signature"
            | "abstract_method_signature" => {
                self.visit_callable(node, depth)?;
            }
            "lexical_declaration" | "variable_declaration" => {
                self.visit_bindings(node, depth)?;
            }
            "import_statement" => declarations::visit_import(self, node)?,
            "export_statement" => declarations::visit_export(self, node, depth)?,
            "type_alias_declaration" => declarations::visit_type_alias(self, node, depth)?,
            "enum_declaration" => declarations::visit_enum(self, node)?,
            _ => return Ok(false),
        }
        Ok(true)
    }

    fn visit_usage(&mut self, node: Node<'_>, depth: usize) -> Result<(), ExtractError> {
        match self.context.snapshot.language() {
            SourceLanguage::Bash
            | SourceLanguage::Fish
            | SourceLanguage::PowerShell
            | SourceLanguage::Zsh => {
                shell_family::capture_usage(self, node)?;
                return self.visit_named_children(node, depth);
            }
            SourceLanguage::C
            | SourceLanguage::Cpp
            | SourceLanguage::Cuda
            | SourceLanguage::Glsl
            | SourceLanguage::Hlsl => {
                c_family::capture_usage(self, node)?;
                return self.visit_named_children(node, depth);
            }
            SourceLanguage::Java | SourceLanguage::CSharp => {
                managed_family::capture_usage(self, node)?;
                return self.visit_named_children(node, depth);
            }
            SourceLanguage::Kotlin | SourceLanguage::Scala | SourceLanguage::Groovy => {
                jvm_dynamic_family::capture_usage(self, node)?;
                return self.visit_named_children(node, depth);
            }
            SourceLanguage::GraphQl => {
                graphql_family::capture_usage(self, node)?;
                return self.visit_named_children(node, depth);
            }
            SourceLanguage::Prisma => {
                prisma_family::capture_usage(self, node)?;
                return self.visit_named_children(node, depth);
            }
            SourceLanguage::Sql => {
                sql_family::capture_usage(self, node)?;
                return self.visit_named_children(node, depth);
            }
            SourceLanguage::Abap
            | SourceLanguage::Apex
            | SourceLanguage::ArkTs
            | SourceLanguage::Astro
            | SourceLanguage::Clojure
            | SourceLanguage::CommonLisp
            | SourceLanguage::Dart
            | SourceLanguage::FSharp
            | SourceLanguage::Hcl
            | SourceLanguage::Html
            | SourceLanguage::Khn
            | SourceLanguage::Lean
            | SourceLanguage::Lua
            | SourceLanguage::Luau
            | SourceLanguage::Nix
            | SourceLanguage::ObjectiveC
            | SourceLanguage::Pascal
            | SourceLanguage::Php
            | SourceLanguage::R
            | SourceLanguage::ReScript
            | SourceLanguage::Ruby
            | SourceLanguage::Solidity
            | SourceLanguage::Swift
            | SourceLanguage::VbNet
            | SourceLanguage::Yaml => {
                generic_family::capture_usage(self, node)?;
                return self.visit_named_children(node, depth);
            }
            SourceLanguage::Rust | SourceLanguage::Python | SourceLanguage::Go => {
                polyglot::capture_usage(self, node)?;
                return self.visit_named_children(node, depth);
            }
            SourceLanguage::TypeScript
            | SourceLanguage::Tsx
            | SourceLanguage::JavaScript
            | SourceLanguage::Jsx => {
                module_system::capture_commonjs_assignment(self, node)?;
            }
            _ => return Err(ExtractError::UnsupportedLanguage),
        }
        match node.kind() {
            "call_expression" => {
                if !module_system::capture_dynamic_import(self, node)? {
                    references::capture_invocation(self, node, references::InvocationKind::Call)?;
                }
            }
            "new_expression" => references::capture_invocation(
                self,
                node,
                references::InvocationKind::Construction,
            )?,
            "jsx_opening_element" | "jsx_self_closing_element" => {
                references::capture_jsx_reference(self, node)?;
            }
            "member_expression" => references::capture_field_access(self, node)?,
            _ => {}
        }
        self.visit_named_children(node, depth)
    }

    fn visit_named_children(&mut self, node: Node<'_>, depth: usize) -> Result<(), ExtractError> {
        for child in named_children(node) {
            self.visit(child, depth.saturating_add(1))?;
        }
        Ok(())
    }

    fn visit_container(&mut self, node: Node<'_>, depth: usize) -> Result<(), ExtractError> {
        let (kind, body_kind) = match node.kind() {
            "interface_declaration" => (SymbolKind::Interface, "interface_body"),
            "class_declaration" | "abstract_class_declaration" => (SymbolKind::Class, "class_body"),
            _ => return self.visit_named_children(node, depth),
        };
        let Some(name_node) = node.child_by_field_name("name") else {
            return self.visit_named_children(node, depth);
        };
        let name = self.context.owned_text(name_node)?;
        let (exported, default_export) = export_flags(node);
        let pending = PendingSymbol {
            kind,
            name: name.clone(),
            span_node: node,
            structural_node: node,
            doc_anchor: node,
            body_node: None,
            declaration_only: false,
            signature: None,
            exported,
            default_export,
            async_symbol: false,
            static_member: false,
            visibility: visibility(node, self.context.source()),
        };
        let id = self.emit_symbol(pending)?;
        self.owners.push(id.clone());
        self.qualifiers.push(name);
        references::capture_heritage(self, node, &id)?;
        for child in named_children(node) {
            if child.kind() == body_kind {
                self.visit(child, depth.saturating_add(1))?;
            }
        }

        self.qualifiers.pop();
        self.owners.pop();
        Ok(())
    }

    fn visit_callable(&mut self, node: Node<'_>, depth: usize) -> Result<(), ExtractError> {
        let Some(name_node) = node.child_by_field_name("name") else {
            return self.visit_named_children(node, depth);
        };
        let name = self.context.owned_text(name_node)?;
        let declared_kind = if matches!(
            node.kind(),
            "method_definition" | "method_signature" | "abstract_method_signature"
        ) {
            SymbolKind::Method
        } else {
            SymbolKind::Function
        };
        let component = declared_kind == SymbolKind::Function
            && starts_uppercase(&name)
            && contains_jsx(node, self.context.cancelled)?;
        let kind = if component {
            SymbolKind::Component
        } else {
            declared_kind
        };
        let (exported, default_export) = export_flags(node);
        let body = node.child_by_field_name("body");
        let pending = PendingSymbol {
            kind,
            name: name.clone(),
            span_node: node,
            structural_node: node,
            doc_anchor: node,
            body_node: body,
            declaration_only: body.is_none(),
            signature: self.context.callable_signature(node)?,
            exported,
            default_export,
            async_symbol: has_child_kind(node, "async"),
            static_member: has_child_kind(node, "static"),
            visibility: visibility(node, self.context.source()),
        };
        let id = self.emit_symbol(pending)?;
        references::capture_callable_types(self, node, &id)?;
        self.owners.push(id);
        self.qualifiers.push(name);
        if let Some(body) = body {
            self.visit(body, depth.saturating_add(1))?;
        }
        self.qualifiers.pop();
        self.owners.pop();
        Ok(())
    }

    fn visit_bindings(&mut self, declaration: Node<'_>, depth: usize) -> Result<(), ExtractError> {
        let constant = has_child_kind(declaration, "const");
        for declarator in named_children(declaration) {
            self.context.ensure_active()?;
            if declarator.kind() != "variable_declarator" {
                continue;
            }
            let Some(name_node) = declarator.child_by_field_name("name") else {
                continue;
            };
            let value = declarator.child_by_field_name("value");
            module_system::capture_commonjs_require(self, name_node, value)?;
            module_system::capture_dynamic_import_binding(self, name_node, value)?;
            if !matches!(name_node.kind(), "identifier" | "property_identifier") {
                continue;
            }
            let name = self.context.owned_text(name_node)?;
            let callable = value
                .filter(|value| matches!(value.kind(), "arrow_function" | "function_expression"));
            let symbol_node = callable.unwrap_or(declarator);
            let component = callable.is_some()
                && starts_uppercase(&name)
                && contains_jsx(symbol_node, self.context.cancelled)?;
            let kind = if component {
                SymbolKind::Component
            } else if callable.is_some() {
                SymbolKind::Function
            } else if constant {
                SymbolKind::Constant
            } else {
                SymbolKind::Variable
            };
            let (exported, default_export) = export_flags(symbol_node);
            let signature = if let Some(callable_node) = callable {
                self.context.callable_signature(callable_node)?
            } else if let Some(value_node) = value {
                self.context.assignment_signature(value_node)?
            } else {
                None
            };
            let pending = PendingSymbol {
                kind,
                name: name.clone(),
                span_node: symbol_node,
                structural_node: symbol_node,
                doc_anchor: declaration,
                body_node: value,
                declaration_only: false,
                signature,
                exported,
                default_export,
                async_symbol: callable.is_some_and(|entry| has_child_kind(entry, "async")),
                static_member: false,
                visibility: None,
            };
            let id = self.emit_symbol(pending)?;
            if callable.is_some() {
                references::capture_callable_types(self, symbol_node, &id)?;
            } else {
                references::capture_type_nodes(self, declarator, &id)?;
            }
            if let Some(value_node) = value {
                self.owners.push(id);
                self.qualifiers.push(name);
                let visit_node = callable
                    .and_then(|callable_node| callable_node.child_by_field_name("body"))
                    .unwrap_or(value_node);
                self.visit(visit_node, depth.saturating_add(1))?;
                self.qualifiers.pop();
                self.owners.pop();
            }
        }
        Ok(())
    }

    fn emit_symbol(&mut self, pending: PendingSymbol<'_>) -> Result<SymbolId, ExtractError> {
        self.context.ensure_active()?;
        let qualified_name = self.qualified_name(&pending.name)?;
        let id = self.identities.next(pending.kind, &qualified_name)?;
        if let Some(parent) = self.owners.last() {
            let containment = Containment {
                parent: parent.clone(),
                child: id.clone(),
            };
            self.context.budget.reserve_fact(
                containment_budget_bytes(&containment),
                [containment.parent.as_str(), containment.child.as_str()],
            )?;
            self.facts.containments.push(containment);
        }
        let span = span_for(pending.span_node)?;
        let docstring = self.context.jsdoc(pending.doc_anchor)?;
        let body_search = match pending.body_node {
            Some(body) => {
                body_search_text(body, self.context.snapshot.source(), self.context.cancelled)?
            }
            None => syntax::BodySearchText::default(),
        };
        let health = syntax::symbol_health_metrics(
            syntax::SymbolHealthInput {
                declaration: pending.structural_node,
                body: pending.body_node,
                symbol_kind: pending.kind,
                symbol_name: &pending.name,
                signature: pending.signature.as_deref(),
                docstring: docstring.as_deref(),
                language: self.context.snapshot.language(),
                async_symbol: pending.async_symbol,
                source: self.context.snapshot.source(),
            },
            self.context.cancelled,
        )?;
        let structural_digest = structural_digest(
            pending.structural_node,
            self.context.snapshot.source(),
            self.context.cancelled,
        )?;
        let clone_shape_digest =
            syntax::clone_shape_digest(pending.structural_node, self.context.cancelled)?;
        let clone_token_profile = matches!(
            pending.kind,
            SymbolKind::Function | SymbolKind::Method | SymbolKind::Component
        )
        .then(|| {
            clone_token_profile(
                pending.structural_node,
                self.context.snapshot.source(),
                self.context.cancelled,
            )
        })
        .transpose()?
        .flatten();
        let top_level = self.owners.is_empty();
        let explicit_export = top_level && self.explicit_exports.contains(&pending.name);
        let explicit_default = top_level && self.explicit_default_exports.contains(&pending.name);
        let symbol = ExtractedSymbol {
            id: id.clone(),
            kind: pending.kind,
            name: pending.name,
            qualified_name,
            span,
            signature: pending.signature,
            docstring,
            body_search_text: body_search.text,
            body_search_truncated: body_search.truncated,
            health,
            declaration_only: pending.declaration_only,
            exported: pending.exported || explicit_export || explicit_default,
            default_export: pending.default_export || explicit_default,
            async_symbol: pending.async_symbol,
            static_member: pending.static_member,
            visibility: pending.visibility,
            structural_digest,
            clone_shape_digest,
            clone_token_profile,
        };
        self.context.budget.reserve_fact(
            symbol_budget_bytes(&symbol),
            [
                symbol.id.as_str(),
                symbol.name.as_str(),
                symbol.qualified_name.as_str(),
                symbol.signature.as_deref().unwrap_or_default(),
                symbol.docstring.as_deref().unwrap_or_default(),
                symbol.body_search_text.as_str(),
                symbol.structural_digest.as_str(),
                symbol.clone_shape_digest.as_str(),
            ],
        )?;
        self.facts.symbols.push(symbol);
        Ok(id)
    }

    fn emit_reference(&mut self, reference: ExtractedReference) -> Result<(), ExtractError> {
        self.context.budget.reserve_fact(
            reference_budget_bytes(&reference),
            [
                reference
                    .owner
                    .as_ref()
                    .map_or("", cartograph_domain::SymbolId::as_str),
                reference.name.as_str(),
            ],
        )?;
        self.facts.references.push(reference);
        Ok(())
    }

    fn emit_import_binding(&mut self, binding: ExtractedImportBinding) -> Result<(), ExtractError> {
        self.context.budget.reserve_fact(
            import_binding_budget_bytes(&binding),
            [
                binding.module_specifier.as_str(),
                binding.imported_name.as_str(),
                binding.local_name.as_str(),
            ],
        )?;
        self.facts.import_bindings.push(binding);
        Ok(())
    }

    fn qualified_name(&self, name: &str) -> Result<String, ExtractError> {
        let length = self
            .qualifiers
            .iter()
            .try_fold(name.len(), |length, qualifier| {
                length
                    .checked_add(qualifier.len())
                    .and_then(|length| length.checked_add(2))
            });
        let length = length.ok_or(ExtractError::OutputLimit)?;
        self.context.budget.ensure_string_length(length)?;
        let mut qualified = String::new();
        qualified
            .try_reserve(length)
            .map_err(|_| ExtractError::OutputLimit)?;
        for qualifier in &self.qualifiers {
            qualified.push_str(qualifier);
            qualified.push_str("::");
        }
        qualified.push_str(name);
        Ok(qualified)
    }
}

impl<'source, 'cancel> ExtractionContext<'source, 'cancel> {
    fn new(
        snapshot: &'source SourceSnapshot,
        cancelled: &'cancel mut dyn FnMut() -> bool,
    ) -> Result<Self, ExtractError> {
        Ok(Self {
            snapshot,
            cancelled,
            budget: ExtractionBudget::new(snapshot)?,
        })
    }

    fn ensure_active(&mut self) -> Result<(), ExtractError> {
        if (self.cancelled)() {
            Err(ExtractError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn source(&self) -> &str {
        self.snapshot.source()
    }

    fn owned_text(&mut self, node: Node<'_>) -> Result<String, ExtractError> {
        self.ensure_active()?;
        let raw_length = node.end_byte().saturating_sub(node.start_byte());
        self.budget.ensure_string_length(raw_length)?;
        let value = self.text(node).trim();
        self.copy_text(value)
    }

    fn owned_unquoted_text(&mut self, node: Node<'_>) -> Result<String, ExtractError> {
        self.ensure_active()?;
        let raw_length = node.end_byte().saturating_sub(node.start_byte());
        self.budget.ensure_string_length(raw_length)?;
        let value = syntax::unquote(self.text(node));
        self.copy_text(value)
    }

    fn copy_text(&self, value: &str) -> Result<String, ExtractError> {
        self.budget.ensure_string_length(value.len())?;
        let mut owned = String::new();
        owned
            .try_reserve(value.len())
            .map_err(|_| ExtractError::OutputLimit)?;
        owned.push_str(value);
        Ok(owned)
    }

    fn callable_signature(&mut self, node: Node<'_>) -> Result<Option<String>, ExtractError> {
        let source = self.snapshot.source();
        let signature = callable_signature(node, source, &mut *self.cancelled)?;
        if let Some(value) = &signature {
            self.budget.ensure_string_length(value.len())?;
        }
        Ok(signature)
    }

    fn assignment_signature(&mut self, node: Node<'_>) -> Result<Option<String>, ExtractError> {
        let value = self.owned_text(node)?;
        if !declaration_value_is_search_safe(&value) {
            return Ok(None);
        }
        let length = value
            .len()
            .checked_add(2)
            .ok_or(ExtractError::OutputLimit)?;
        self.budget.ensure_string_length(length)?;
        let mut signature = String::new();
        signature
            .try_reserve(length)
            .map_err(|_| ExtractError::OutputLimit)?;
        signature.push_str("= ");
        signature.push_str(&value);
        Ok(Some(signature))
    }

    fn jsdoc(&mut self, node: Node<'_>) -> Result<Option<String>, ExtractError> {
        if self.snapshot.language() == SourceLanguage::GraphQl {
            return graphql_family::description_from_context(self, node);
        }
        let source = self.snapshot.source();
        let docstring = jsdoc(node, source, &mut *self.cancelled)?;
        if let Some(value) = &docstring {
            self.budget.ensure_string_length(value.len())?;
        }
        Ok(docstring)
    }

    fn text(&self, node: Node<'_>) -> &str {
        self.source()
            .get(node.start_byte()..node.end_byte())
            .unwrap_or_default()
    }
}
