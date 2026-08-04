//! Shader-family extraction contracts for WGSL and Metal.

mod dependency_ownership;

use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolKind, Visibility};
use cartograph_extract::{
    ExtractError, ExtractedFile, NativeExtractor, SourceLimits, SourceSnapshot,
};

const SOURCE_LIMIT: usize = 1024 * 1024;

#[test]
fn wgsl_extracts_stage_entry_points_bindings_structs_and_module_imports() {
    let source = r"#define_import_path pbr::lighting
#import pbr::common

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@group(0) @binding(0)
var<uniform> view_projection: mat4x4<f32>;

@group(1) @binding(2)
var base_color_texture: texture_2d<f32>;

fn tone_map(color: vec4<f32>) -> vec4<f32> {
    return color;
}

@vertex
fn vertex_main(@location(0) position: vec3<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = view_projection * vec4<f32>(position, 1.0);
    return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return tone_map(in.clip_position);
}

@compute @workgroup_size(8, 8, 1)
fn compute_main() {
}
";
    let extracted = extract("shaders/pbr.wgsl", source);
    assert_eq!(extracted.language, SourceLanguage::Wgsl);

    // Entry points are the top of a real call stack and must be typed by stage,
    // not flattened into "some function" (issue #121).
    for (name, stage) in [
        ("vertex_main", "@vertex"),
        ("fragment_main", "@fragment"),
        ("compute_main", "@compute"),
    ] {
        let entry = symbol(&extracted, SymbolKind::Function, name);
        assert_eq!(
            entry.visibility,
            Some(Visibility::Public),
            "{name} is reachable from the host pipeline"
        );
        let signature = entry
            .signature
            .as_deref()
            .unwrap_or_else(|| panic!("{name} lost its signature"));
        assert!(
            signature.starts_with(stage),
            "{name} must record its pipeline stage, got {signature}"
        );
    }

    // A shader-internal helper is not a pipeline boundary.
    let helper = symbol(&extracted, SymbolKind::Function, "tone_map");
    assert_eq!(helper.visibility, Some(Visibility::Internal));

    symbol(&extracted, SymbolKind::Struct, "VertexOutput");
    symbol(&extracted, SymbolKind::Field, "clip_position");
    symbol(&extracted, SymbolKind::Field, "uv");

    // A module-scope binding is a declaration the host layout must match. Its
    // declared type is carried as a typed reference edge rather than only as a
    // string, so impact analysis reaches it. The `@group`/`@binding` indices are
    // deliberately not spelled into the signature: a literal-bearing signature is
    // rejected before persistence, which would blank the declared type too.
    let uniform = symbol(&extracted, SymbolKind::Variable, "view_projection");
    assert_eq!(
        uniform.signature.as_deref(),
        Some("var<uniform>: mat4x4<f32>")
    );
    symbol(&extracted, SymbolKind::Variable, "base_color_texture");
    assert!(
        extracted.references.iter().any(|reference| {
            reference.kind == ReferenceKind::TypeOf && reference.name == "mat4x4<f32>"
        }),
        "the binding's declared type was not recorded as a typed edge"
    );

    // naga_oil forms the shader module graph.
    symbol(&extracted, SymbolKind::Module, "pbr::lighting");
    assert!(
        extracted.references.iter().any(|reference| {
            reference.kind == ReferenceKind::Imports && reference.name == "pbr::common"
        }),
        "the imported shader module was not recorded"
    );
    assert_eq!(
        extracted.parse_status,
        cartograph_domain::FileParseStatus::Parsed,
        "the shader fixture must parse cleanly"
    );

    // An intra-file call keeps callers/callees working inside one shader.
    assert!(
        extracted.references.iter().any(|reference| {
            reference.kind == ReferenceKind::Calls && reference.name == "tone_map"
        }),
        "the intra-file shader call was not recorded"
    );
}

#[test]
fn wgsl_without_declarations_is_legitimately_empty_rather_than_unsupported() {
    let extracted = extract("shaders/empty.wgsl", "// only a comment\n");
    assert_eq!(extracted.language, SourceLanguage::Wgsl);
    assert!(extracted.symbols.is_empty());
}

#[test]
fn metal_reuses_the_c_family_slice_for_kernels_and_structs() {
    let source = r"#include <metal_stdlib>
using namespace metal;

struct Uniforms {
    float4x4 modelViewProjection;
};

float4 tonemap(float4 color) {
    return color;
}

kernel void compute_main(device float4 *output [[buffer(0)]],
                         uint index [[thread_position_in_grid]]) {
    output[index] = tonemap(output[index]);
}
";
    let extracted = extract("shaders/pipeline.metal", source);
    assert_eq!(extracted.language, SourceLanguage::Metal);
    symbol(&extracted, SymbolKind::Struct, "Uniforms");
    assert!(
        extracted
            .symbols
            .iter()
            .any(|symbol| symbol.name == "tonemap"),
        "the Metal helper function was not extracted"
    );
    assert!(
        extracted.references.iter().any(|reference| {
            reference.kind == ReferenceKind::Calls && reference.name == "tonemap"
        }),
        "the Metal call was not recorded"
    );
}

fn extract(path: &str, source: &str) -> ExtractedFile {
    let limits = SourceLimits::new(SOURCE_LIMIT)
        .unwrap_or_else(|error| panic!("source limits failed: {error}"));
    let snapshot =
        SourceSnapshot::from_bytes_for_capability_validation(path, source.as_bytes(), limits)
            .unwrap_or_else(|error| panic!("snapshot failed for {path}: {error}"));
    let mut extractor = NativeExtractor::new_for_capability_validation(snapshot.language())
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

#[test]
fn quoted_path_imports_stay_explicitly_unparsed_rather_than_silently_dropped() {
    // The pinned grammar accepts naga_oil module-path imports but not the
    // quoted-file form. That gap must surface as a recoverable diagnostic, never
    // as a file that looks successfully empty.
    let extracted = extract("shaders/quoted.wgsl", "#import \"shaders/common.wgsl\"\n");
    assert_eq!(
        extracted.parse_status,
        cartograph_domain::FileParseStatus::Partial,
        "an unparsed import form must be reported, not silently skipped"
    );
    assert!(
        !extracted.diagnostics.is_empty(),
        "a partial shader parse must carry a diagnostic"
    );
}
