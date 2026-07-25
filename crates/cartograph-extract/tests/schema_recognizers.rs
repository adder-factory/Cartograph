use cartograph_domain::{ReferenceKind, SymbolKind};
use cartograph_extract::{ExtractedFile, NativeExtractor, SourceLimits, SourceSnapshot};

const SOURCE_LIMIT: usize = 1024 * 1024;

#[test]
fn zod_schemas_emit_nested_shape_enums_inline_contracts_and_consumers() {
    let source = r#"
import { z } from 'zod';

export const UserSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['admin', 'viewer', 'sk_live_must_not_escape']),
  address: z.object({
    city: z.string(),
  }),
}).strict();

export type User = z.infer<typeof UserSchema>;
export const PublicUser = UserSchema.pick({ name: true });
function checkRole() { return UserSchema.shape.role; }
function defineTool(value: unknown) { return value; }
defineTool({ input: z.object({ query: z.string() }) });
"#;
    let first = extract("src/contracts.ts", source);
    let second = extract("src/contracts.ts", source);
    assert_eq!(first, second);

    for (kind, qualified_name) in [
        (SymbolKind::Struct, "UserSchema"),
        (SymbolKind::Field, "UserSchema::name"),
        (SymbolKind::Field, "UserSchema::role"),
        (SymbolKind::Field, "UserSchema::address"),
        (SymbolKind::Struct, "UserSchema::address"),
        (SymbolKind::Field, "UserSchema::address::city"),
        (SymbolKind::Struct, "input"),
        (SymbolKind::Field, "input::query"),
        (SymbolKind::EnumMember, "UserSchema::role::admin"),
        (SymbolKind::EnumMember, "UserSchema::role::viewer"),
    ] {
        assert!(
            first
                .symbols
                .iter()
                .any(|symbol| symbol.kind == kind && symbol.qualified_name == qualified_name),
            "missing {kind:?} {qualified_name}: {:?}",
            first.symbols
        );
    }
    assert!(first.symbols.iter().all(|symbol| {
        !symbol.name.contains("sk_live")
            && !symbol.qualified_name.contains("sk_live")
            && !symbol
                .signature
                .as_deref()
                .is_some_and(|signature| signature.contains("sk_live"))
    }));

    let user = symbol(&first, SymbolKind::Struct, "UserSchema");
    let name = symbol(&first, SymbolKind::Field, "UserSchema::name");
    let role = symbol(&first, SymbolKind::Field, "UserSchema::role");
    let address_field = symbol(&first, SymbolKind::Field, "UserSchema::address");
    let address = symbol(&first, SymbolKind::Struct, "UserSchema::address");
    assert!(contains(&first, &user.id, &name.id));
    assert!(contains(&first, &user.id, &role.id));
    assert!(contains(&first, &user.id, &address_field.id));
    assert!(contains(&first, &address_field.id, &address.id));
    assert_eq!(name.signature.as_deref(), Some("z.string"));
    assert_eq!(role.signature.as_deref(), Some("z.enum"));

    assert!(first.references.iter().any(|reference| {
        reference.kind == ReferenceKind::TypeOf && reference.name == "UserSchema"
    }));
    for field in ["name", "role"] {
        assert!(first.references.iter().any(|reference| {
            reference.kind == ReferenceKind::References
                && reference.name == field
                && reference.resolution_name.as_deref() == Some(&format!("UserSchema::{field}"))
        }));
    }
}

#[test]
fn zod_recognizer_requires_a_real_zod_import() {
    let extracted = extract(
        "src/fake.ts",
        "const z = { object: (value: unknown) => value };\nexport const Fake = z.object({ field: 1 });\n",
    );
    assert!(
        extracted
            .symbols
            .iter()
            .all(|symbol| symbol.kind != SymbolKind::Struct)
    );
}

#[test]
fn pydantic_models_emit_struct_fields_literal_members_and_skip_class_vars() {
    let source = r#"
from pydantic import BaseModel
from typing import ClassVar, Literal

class Helper:
    ignored: int

class User(BaseModel):
    version: ClassVar[int]
    name: str
    age: int = 0
    role: Literal['admin', 'viewer', 'ghp_must_not_escape']

class Account(pydantic.BaseModel):
    id: str
"#;
    let first = extract("models.py", source);
    let second = extract("models.py", source);
    assert_eq!(first, second);

    for qualified_name in ["User", "Account"] {
        assert!(
            first.symbols.iter().any(|symbol| {
                symbol.kind == SymbolKind::Struct && symbol.qualified_name == qualified_name
            }),
            "missing Pydantic struct {qualified_name}: {:?}",
            first.symbols
        );
    }
    for qualified_name in ["User::name", "User::age", "User::role", "Account::id"] {
        assert!(
            first.symbols.iter().any(|symbol| {
                symbol.kind == SymbolKind::Field && symbol.qualified_name == qualified_name
            }),
            "missing Pydantic field {qualified_name}: {:?}",
            first.symbols
        );
    }
    assert!(first.symbols.iter().all(|symbol| {
        symbol.qualified_name != "User::version"
            && !symbol.name.contains("ghp_")
            && !symbol.qualified_name.contains("ghp_")
            && !symbol
                .signature
                .as_deref()
                .is_some_and(|signature| signature.contains("ghp_"))
    }));
    for qualified_name in ["User::role::admin", "User::role::viewer"] {
        assert!(first.symbols.iter().any(|symbol| {
            symbol.kind == SymbolKind::EnumMember && symbol.qualified_name == qualified_name
        }));
    }
    let user = symbol(&first, SymbolKind::Struct, "User");
    let name = symbol(&first, SymbolKind::Field, "User::name");
    assert!(contains(&first, &user.id, &name.id));
    assert_eq!(name.signature.as_deref(), Some("str"));
    let role = symbol(&first, SymbolKind::Field, "User::role");
    assert_eq!(role.signature.as_deref(), Some("Literal[...]"));
}

fn extract(path: &str, source: &str) -> ExtractedFile {
    let snapshot = SourceSnapshot::from_bytes(path, source.as_bytes(), limits())
        .unwrap_or_else(|error| panic!("schema snapshot failed: {error}"));
    let mut extractor = NativeExtractor::new(snapshot.language())
        .unwrap_or_else(|error| panic!("schema extractor failed: {error}"));
    extractor
        .extract(&snapshot)
        .unwrap_or_else(|error| panic!("schema extraction failed: {error}"))
}

fn symbol<'file>(
    file: &'file ExtractedFile,
    kind: SymbolKind,
    qualified_name: &str,
) -> &'file cartograph_extract::ExtractedSymbol {
    let mut symbols = file
        .symbols
        .iter()
        .filter(|symbol| symbol.kind == kind && symbol.qualified_name == qualified_name);
    let symbol = symbols
        .next()
        .unwrap_or_else(|| panic!("missing {kind:?} {qualified_name}: {:?}", file.symbols));
    assert!(
        symbols.next().is_none(),
        "ambiguous {kind:?} {qualified_name}"
    );
    symbol
}

fn contains(
    file: &ExtractedFile,
    parent: &cartograph_domain::SymbolId,
    child: &cartograph_domain::SymbolId,
) -> bool {
    file.containments
        .iter()
        .any(|containment| &containment.parent == parent && &containment.child == child)
}

fn limits() -> SourceLimits {
    SourceLimits::new(SOURCE_LIMIT)
        .unwrap_or_else(|error| panic!("schema source limit failed: {error}"))
}
