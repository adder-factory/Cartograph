//! Ada and VHDL extraction contracts.

mod dependency_ownership;

use cartograph_domain::{FileParseStatus, ReferenceKind, SourceLanguage, SymbolKind};
use cartograph_extract::{
    ExtractError, ExtractedFile, ImportBindingKind, NativeExtractor, SourceLimits, SourceSnapshot,
};

const SOURCE_LIMIT: usize = 1024 * 1024;

#[test]
fn ada_extracts_case_insensitive_units_callables_calls_and_context_clauses() {
    let extracted = extract(
        "src/mixed_case.adb",
        r"with Project.Math;
use Project.Math;

package body Mixed_Case is
   function Compute (Value : Integer) return Integer is
   begin
      return Normalize (Value);
   end Compute;
end Mixed_Case;
",
    );
    assert_eq!(extracted.language, SourceLanguage::Ada);
    assert_eq!(extracted.parse_status, FileParseStatus::Parsed);

    let package = symbol(&extracted, SymbolKind::Module, "mixed_case");
    assert!(!package.implementation.declaration_only);
    let function = symbol(&extracted, SymbolKind::Function, "compute");
    assert_eq!(function.qualified_name, "mixed_case::compute");
    assert!(
        function.signature.is_none(),
        "literal-bearing defaults must never leak"
    );
    assert!(extracted.references.iter().any(|reference| {
        reference.owner.as_ref() == Some(&function.id)
            && reference.kind == ReferenceKind::Calls
            && reference.name == "normalize"
    }));
    assert!(extracted.references.iter().any(|reference| {
        reference.kind == ReferenceKind::Imports && reference.name == "project.math"
    }));
    assert!(extracted.import_bindings.iter().any(|binding| {
        binding.kind == ImportBindingKind::Namespace
            && binding.module_specifier == "project.math"
            && binding.local_name == "math"
    }));
    assert!(extracted.import_bindings.iter().any(|binding| {
        binding.kind == ImportBindingKind::Namespace
            && binding.module_specifier == "project.math"
            && binding.local_name == "*"
    }));
}

#[test]
fn vhdl_extracts_packages_functions_calls_and_work_library_bindings() {
    let source = r"library ieee;
use ieee.std_logic_1164.all;
use work.math_pkg.all;

package math_pkg is
   function Normalize (Value : integer) return integer;
end package;

package body math_pkg is
   function Normalize (Value : integer) return integer is
   begin
      return Value;
   end function;

   function Compute (Value : integer) return integer is
   begin
      return Normalize(Value);
   end function;
end package body;
";
    let extracted = extract("rtl/math_pkg.vhd", source);
    assert_eq!(extracted.language, SourceLanguage::Vhdl);
    assert_eq!(extracted.parse_status, FileParseStatus::Parsed);

    let modules = extracted
        .symbols
        .iter()
        .filter(|symbol| symbol.kind == SymbolKind::Module && symbol.name == "math_pkg")
        .collect::<Vec<_>>();
    assert_eq!(
        modules.len(),
        2,
        "package declaration and body must both be retained"
    );
    assert!(
        modules
            .iter()
            .any(|symbol| symbol.implementation.declaration_only)
    );
    assert!(
        modules
            .iter()
            .any(|symbol| !symbol.implementation.declaration_only)
    );
    let compute = symbol(&extracted, SymbolKind::Function, "compute");
    assert!(
        extracted.references.iter().any(|reference| {
            reference.owner.as_ref() == Some(&compute.id)
                && reference.kind == ReferenceKind::Calls
                && reference.name == "normalize"
        }),
        "VHDL references: {:?}",
        extracted.references
    );
    assert!(extracted.import_bindings.iter().any(|binding| {
        binding.kind == ImportBindingKind::Namespace
            && binding.module_specifier == "math_pkg"
            && binding.local_name == "*"
    }));
    assert!(extracted.import_bindings.iter().any(|binding| {
        binding.module_specifier == "ieee.std_logic_1164" && binding.local_name == "*"
    }));
}

#[test]
fn ada_specs_types_objects_components_and_declarations_remain_structural() {
    let extracted = extract(
        "src/widgets.ads",
        r"with Ada.Text_IO;

package Widgets is
   type Counter is range 0 .. 100;
   subtype Small_Counter is Counter range 0 .. 10;
   type Pair is record
      Left  : Integer;
      Right : Integer;
   end record;
   Maximum : constant Integer := 100;
   Current, Next : Integer := 0;
   procedure Reset;
end Widgets;
",
    );
    assert_eq!(extracted.parse_status, FileParseStatus::Parsed);
    assert!(
        symbol(&extracted, SymbolKind::Module, "widgets")
            .implementation
            .declaration_only
    );
    for name in ["counter", "small_counter", "pair"] {
        let _ = symbol(&extracted, SymbolKind::TypeAlias, name);
    }
    let _ = symbol(&extracted, SymbolKind::Constant, "maximum");
    for name in ["current", "next"] {
        let _ = symbol(&extracted, SymbolKind::Variable, name);
    }
    for name in ["left", "right"] {
        let field = symbol(&extracted, SymbolKind::Field, name);
        assert_eq!(field.qualified_name, format!("widgets::pair::{name}"));
    }
    assert!(
        symbol(&extracted, SymbolKind::Function, "reset")
            .implementation
            .declaration_only
    );
}

#[test]
fn vhdl_entities_architectures_bindings_and_instantiations_are_typed() {
    let extracted = extract(
        "rtl/top.vhdl",
        r"library ieee;
use ieee.std_logic_1164.std_logic;

entity Top is
end entity Top;

architecture Rtl of Top is
   component Worker is
   end component;
   type State is (Idle, Busy);
   subtype Index_Value is integer range 0 to 3;
   constant Limit : integer := 3;
   signal Ready : std_logic;
   variable Count : integer := 0;
   function Helper(Value : integer) return integer is
   begin
      return Value;
   end function;
   procedure Tick(Value : in integer) is
   begin
      Count := Helper(Value);
   end procedure;
begin
   Unit_One : component Worker;
   Tick(Limit);
end architecture Rtl;
",
    );
    assert_eq!(extracted.parse_status, FileParseStatus::Parsed);
    assert!(
        symbol(&extracted, SymbolKind::Interface, "top")
            .implementation
            .declaration_only
    );
    let architecture = symbol(&extracted, SymbolKind::Module, "rtl");
    assert!(!architecture.implementation.declaration_only);
    let _ = symbol(&extracted, SymbolKind::Interface, "worker");
    for name in ["state", "index_value"] {
        let _ = symbol(&extracted, SymbolKind::TypeAlias, name);
    }
    let _ = symbol(&extracted, SymbolKind::Constant, "limit");
    let _ = symbol(&extracted, SymbolKind::Field, "ready");
    let _ = symbol(&extracted, SymbolKind::Variable, "count");
    for name in ["helper", "tick"] {
        assert!(
            !symbol(&extracted, SymbolKind::Function, name)
                .implementation
                .declaration_only
        );
    }
    assert!(extracted.references.iter().any(|reference| {
        reference.owner.as_ref() == Some(&architecture.id)
            && reference.kind == ReferenceKind::TypeOf
            && reference.name == "top"
    }));
    assert!(extracted.references.iter().any(|reference| {
        reference.kind == ReferenceKind::Instantiates && reference.name == "worker"
    }));
    assert!(extracted.import_bindings.iter().any(|binding| {
        binding.kind == ImportBindingKind::Named
            && binding.module_specifier == "ieee.std_logic_1164"
            && binding.imported_name == "std_logic"
    }));
}

#[test]
fn ada_and_vhdl_extensions_are_additive_and_spark_uses_ada() {
    for (path, language) in [
        ("src/worker.ADS", SourceLanguage::Ada),
        ("src/worker.adb", SourceLanguage::Ada),
        ("src/worker.ada", SourceLanguage::Ada),
        ("rtl/worker.VHD", SourceLanguage::Vhdl),
        ("rtl/worker.vhdl", SourceLanguage::Vhdl),
    ] {
        assert_eq!(
            SourceLanguage::for_normalized_path(path),
            Some(language),
            "{path}"
        );
        assert_eq!(
            SourceLanguage::for_v1_normalized_path_with_source(path, ""),
            None,
            "{path} must not change the frozen v1 language boundary"
        );
    }
    assert_eq!(
        SourceLanguage::for_normalized_path("project/demo.gpr"),
        None
    );
}

#[test]
fn malformed_ada_and_vhdl_remain_recoverable_partial_files() {
    for (path, source) in [
        (
            "src/broken.adb",
            "package body Broken is function Missing return Integer is",
        ),
        (
            "rtl/broken.vhd",
            "package broken is function Missing return integer",
        ),
    ] {
        let extracted = extract(path, source);
        assert_eq!(extracted.parse_status, FileParseStatus::Partial, "{path}");
        assert!(!extracted.diagnostics.is_empty(), "{path}");
    }
}

fn extract(path: &str, source: &str) -> ExtractedFile {
    let limits = SourceLimits::new(SOURCE_LIMIT)
        .unwrap_or_else(|error| panic!("source limits failed: {error}"));
    let snapshot = SourceSnapshot::from_bytes(path, source.as_bytes(), limits)
        .unwrap_or_else(|error| panic!("snapshot failed for {path}: {error}"));
    let mut extractor = NativeExtractor::new(snapshot.language())
        .unwrap_or_else(|error: ExtractError| panic!("extractor failed for {path}: {error}"));
    extractor
        .extract(&snapshot)
        .unwrap_or_else(|error| panic!("extraction failed for {path}: {error}"))
}

fn symbol<'file>(
    extracted: &'file ExtractedFile,
    kind: SymbolKind,
    name: &str,
) -> &'file cartograph_extract::ExtractedSymbol {
    extracted
        .symbols
        .iter()
        .find(|symbol| symbol.kind == kind && symbol.name == name)
        .unwrap_or_else(|| {
            let available = extracted
                .symbols
                .iter()
                .map(|symbol| format!("{:?} {}", symbol.kind, symbol.name))
                .collect::<Vec<_>>();
            panic!("missing {kind:?} {name}; extracted: {available:?}")
        })
}
