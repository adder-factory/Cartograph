//! Bounded structural coverage for textual game scripting languages added in v2.1.7.

mod dependency_ownership;

use cartograph_domain::{FileParseStatus, ReferenceKind, SourceLanguage, SymbolKind};
use cartograph_extract::{ExtractError, NativeExtractor, SourceLimits, SourceSnapshot};

const SOURCE_LIMIT: usize = 1024 * 1024;
const SECRET_SENTINEL: &str = "cartograph_game_script_literal_secret_8a31";

struct Fixture {
    language: SourceLanguage,
    path: &'static str,
    source: &'static str,
    symbol_kind: SymbolKind,
    symbol_name: &'static str,
    reference_kind: ReferenceKind,
    reference_name: &'static str,
}

const FIXTURES: &[Fixture] = &[
    Fixture {
        language: SourceLanguage::ActionScript,
        path: "flash/Start.as",
        source: "package game { public function Start() { Helper(); } }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::AgsScript,
        path: "ags/room.asc",
        source: "function Start() { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::AngelScript,
        path: "scripts/start.as",
        source: "shared class Start { void Run() { Helper(); } }",
        symbol_kind: SymbolKind::Class,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Boo,
        path: "legacy/start.boo",
        source: "def start():\n    helper()",
        symbol_kind: SymbolKind::Function,
        symbol_name: "start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "helper",
    },
    Fixture {
        language: SourceLanguage::ByondDm,
        path: "world/start.dm",
        source: "/mob/proc/start()\n    helper()",
        symbol_kind: SymbolKind::Function,
        symbol_name: "start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "helper",
    },
    Fixture {
        language: SourceLanguage::ChoiceScript,
        path: "game/scenes/startup.txt",
        source: "*label start\n*choice\n  #Continue\n    *gosub helper",
        symbol_kind: SymbolKind::Function,
        symbol_name: "start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "helper",
    },
    Fixture {
        language: SourceLanguage::Daedalus,
        path: "gothic/start.d",
        source: "INSTANCE Start (C_NPC) { }\nFUNC VOID Run() { Helper(); };",
        symbol_kind: SymbolKind::Resource,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::DoomAcs,
        path: "doom/start.acs",
        source: "#include \"zcommon.acs\"\nfunction void Start(void) { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::DoomDecorate,
        path: "doom/actors/DECORATE",
        source: "actor Start 1000 { States { Spawn: TNT1 A 0 Helper(); } }",
        symbol_kind: SymbolKind::Class,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::EnforceScript,
        path: "DayZ/scripts/4_World/Start.c",
        source: "modded class Start { override void Run() { Helper(); } }",
        symbol_kind: SymbolKind::Class,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Galaxy,
        path: "sc2/start.galaxy",
        source: "void Start() { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::GameMakerLanguage,
        path: "gamemaker/start.gml",
        source: "function Start() { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::GameMonkey,
        path: "engine/start.gm",
        source: "function Start() { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::GdScript,
        path: "godot/start.gd",
        source: "class_name Start\nextends Node\nfunc run():\n    helper()",
        symbol_kind: SymbolKind::Class,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "helper",
    },
    Fixture {
        language: SourceLanguage::Gsc,
        path: "cod/start.gsc",
        source: "Start() { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::HaloScript,
        path: "halo/start.hsc",
        source: "(script static void Start\n  (wake Helper)\n)",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Hscript,
        path: "haxe/start.hscript",
        source: "function Start() { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::IdTechScript,
        path: "doom3/start.script",
        source: "void Start() { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Inform6,
        path: "inform/start.inf",
        source: "Constant Story \"Start\";\nInclude \"Parser\";\n[ Start; Helper(); ];",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Inform7,
        path: "inform/Story.ni",
        source: "To start:\n    follow helper rule.",
        symbol_kind: SymbolKind::Function,
        symbol_name: "start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "helper",
    },
    Fixture {
        language: SourceLanguage::Ink,
        path: "narrative/start.ink",
        source: "=== Start ===\n-> Helper",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Jass,
        path: "warcraft/start.j",
        source: "library Start\nfunction Run takes nothing returns nothing\n call Helper()\nendfunction\nendlibrary",
        symbol_kind: SymbolKind::Module,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::KerboScript,
        path: "ksp/start.ks",
        source: "FUNCTION Start { Helper(). }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Lpc,
        path: "mudlib/start.c",
        source: "inherit \"/std/object\";\nvoid start() { helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "helper",
    },
    Fixture {
        language: SourceLanguage::Lsl,
        path: "secondlife/start.lsl",
        source: "default { state_entry() { Helper(); } }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "state_entry",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::MinecraftFunction,
        path: "data/demo/functions/start.mcfunction",
        source: "function demo:helper",
        symbol_kind: SymbolKind::Function,
        symbol_name: "demo:start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "demo:helper",
    },
    Fixture {
        language: SourceLanguage::MiniScript,
        path: "miniscript/start.ms",
        source: "start = function()\n  helper()\nend function",
        symbol_kind: SymbolKind::Function,
        symbol_name: "start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "helper",
    },
    Fixture {
        language: SourceLanguage::NwScript,
        path: "nwn/start.nss",
        source: "void Start() { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Papyrus,
        path: "skyrim/Start.psc",
        source: "Scriptname Start extends Quest\nFunction Run()\n  Helper()\nEndFunction",
        symbol_kind: SymbolKind::Class,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::ParadoxScript,
        path: "stellaris/events/start.txt",
        source: "country_event = { id = test.1 trigger = { helper_trigger = yes } }",
        symbol_kind: SymbolKind::Resource,
        symbol_name: "country_event",
        reference_kind: ReferenceKind::Calls,
        reference_name: "helper_trigger",
    },
    Fixture {
        language: SourceLanguage::Pawn,
        path: "pawn/start.pwn",
        source: "public Start() { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Pico8,
        path: "pico/start.p8",
        source: "pico-8 cartridge // http://www.pico-8.com\n__lua__\nfunction start() helper() end\n__gfx__\n00112233",
        symbol_kind: SymbolKind::Function,
        symbol_name: "start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "helper",
    },
    Fixture {
        language: SourceLanguage::QuakeC,
        path: "quake/start.qc",
        source: "void() Start = { Helper(); };",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Redscript,
        path: "cyberpunk/start.reds",
        source: "public func Start() -> Void { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Renpy,
        path: "renpy/start.rpy",
        source: "label start:\n    call helper\n    return",
        symbol_kind: SymbolKind::Function,
        symbol_name: "start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "helper",
    },
    Fixture {
        language: SourceLanguage::Skript,
        path: "minecraft/start.sk",
        source: "function start():\n    helper()",
        symbol_kind: SymbolKind::Function,
        symbol_name: "start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "helper",
    },
    Fixture {
        language: SourceLanguage::SourcePawn,
        path: "sourcemod/start.sp",
        source: "public void Start() { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Sqf,
        path: "arma/start.sqf",
        source: "Start = { call Helper; };",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Sqs,
        path: "arma/start.sqs",
        source: "#Start\ngoto \"Helper\"",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Squirrel,
        path: "vscript/start.nut",
        source: "function Start() { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Tads,
        path: "tads/start.t",
        source: "#include <adv3.h>\nstartRoom: Room 'Start' { }\nfunction Run() { Helper(); }",
        symbol_kind: SymbolKind::Resource,
        symbol_name: "startRoom",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::TorqueScript,
        path: "torque/start.cs",
        source: "function Start(%value) { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Twee,
        path: "twine/start.twee",
        source: ":: Start\n[[Continue->Helper]]",
        symbol_kind: SymbolKind::Resource,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::UnrealScript,
        path: "unreal/Start.uc",
        source: "class Start extends Object;\nfunction Run() { Helper(); }",
        symbol_kind: SymbolKind::Class,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::ValveQc,
        path: "source/start.qc",
        source: "$modelname \"start.mdl\"\n$sequence Start \"idle.smd\"\n$include \"helper.qci\"",
        symbol_kind: SymbolKind::Resource,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Imports,
        reference_name: "helper.qci",
    },
    Fixture {
        language: SourceLanguage::Verse,
        path: "uefn/start.verse",
        source: "Start():void = { Helper() }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::WitcherScript,
        path: "witcher/start.ws",
        source: "function void Start() { Helper(); }",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Wren,
        path: "wren/start.wren",
        source: "class Start { }\nvar value = Helper()",
        symbol_kind: SymbolKind::Class,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::WurstScript,
        path: "warcraft/start.wurst",
        source: "package Start\nfunction run()\n    Helper()",
        symbol_kind: SymbolKind::Module,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::YarnSpinner,
        path: "dialogue/start.yarn",
        source: "title: Start\n---\n<<jump Helper>>\n===",
        symbol_kind: SymbolKind::Function,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
    Fixture {
        language: SourceLanguage::Zscript,
        path: "doom/zscript.txt",
        source: "class Start : Actor { void Run() { Helper(); } }",
        symbol_kind: SymbolKind::Class,
        symbol_name: "Start",
        reference_kind: ReferenceKind::Calls,
        reference_name: "Helper",
    },
];

#[test]
fn every_game_script_mode_discovers_and_extracts_deterministic_structure() {
    assert_eq!(FIXTURES.len(), 51);
    for fixture in FIXTURES {
        let source = fixture_source(fixture.source);
        let snapshot = snapshot(fixture.path, &source);
        assert_eq!(snapshot.language(), fixture.language, "{}", fixture.path);
        let mut extractor = NativeExtractor::new(fixture.language)
            .unwrap_or_else(|error| panic!("{} extractor failed: {error}", fixture.path));
        let first = extractor
            .extract(&snapshot)
            .unwrap_or_else(|error| panic!("{} extraction failed: {error}", fixture.path));
        let second = extractor
            .extract(&snapshot)
            .unwrap_or_else(|error| panic!("{} repeat failed: {error}", fixture.path));
        assert_eq!(first, second, "{} was not deterministic", fixture.path);
        assert_eq!(
            first.parse_status,
            FileParseStatus::Parsed,
            "{}",
            fixture.path
        );
        assert!(
            first.symbols.iter().any(|symbol| {
                symbol.kind == fixture.symbol_kind && symbol.name == fixture.symbol_name
            }),
            "{} missing {:?} {}; symbols={:?}",
            fixture.path,
            fixture.symbol_kind,
            fixture.symbol_name,
            first.symbols
        );
        assert!(
            first.references.iter().any(|reference| {
                reference.kind == fixture.reference_kind && reference.name == fixture.reference_name
            }),
            "{} missing {:?} {}; references={:?}",
            fixture.path,
            fixture.reference_kind,
            fixture.reference_name,
            first.references
        );
        let debug = format!("{first:?}");
        assert!(
            !debug.contains(SECRET_SENTINEL),
            "{} leaked a literal",
            fixture.path
        );
        assert!(
            !debug.contains("FakeCall"),
            "{} retained a literal call",
            fixture.path
        );
    }
}

#[test]
fn game_script_modes_mark_malformed_input_partial_and_poll_cancellation() {
    for fixture in FIXTURES {
        let mut malformed_source = fixture_source(fixture.source);
        if fixture.language == SourceLanguage::Pico8 {
            let boundary = malformed_source
                .find("__gfx__")
                .unwrap_or(malformed_source.len());
            malformed_source.insert_str(boundary, "\"unterminated\n");
        } else {
            malformed_source.push_str("\n\"unterminated");
        }
        let malformed = snapshot(fixture.path, &malformed_source);
        let mut extractor = NativeExtractor::new(fixture.language)
            .unwrap_or_else(|error| panic!("{} extractor failed: {error}", fixture.path));
        let extracted = extractor.extract(&malformed).unwrap_or_else(|error| {
            panic!("{} malformed extraction failed: {error}", fixture.path)
        });
        assert_eq!(
            extracted.parse_status,
            FileParseStatus::Partial,
            "{}",
            fixture.path
        );

        let source = fixture_source(fixture.source);
        let cancelled = snapshot(fixture.path, &source);
        assert_eq!(
            extractor.extract_with_cancellation(&cancelled, || true),
            Err(ExtractError::Cancelled),
            "{}",
            fixture.path
        );
    }
}

#[test]
fn extension_collisions_use_content_without_changing_the_frozen_v1_route() {
    assert_language(
        "scripts/action.as",
        "package game { class Start {} }",
        SourceLanguage::ActionScript,
    );
    assert_language(
        "scripts/angel.as",
        "shared class Start {}",
        SourceLanguage::AngelScript,
    );
    assert_language(
        "native/start.c",
        "int main(void) { return 0; }",
        SourceLanguage::C,
    );
    assert_language(
        "DayZ/scripts/4_World/Start.c",
        "modded class Start {}",
        SourceLanguage::EnforceScript,
    );
    assert_language(
        "mudlib/start.c",
        "inherit \"/std/object\";\nvoid create() {}",
        SourceLanguage::Lpc,
    );
    assert_language(
        "managed/Start.cs",
        "public class Start {}",
        SourceLanguage::CSharp,
    );
    assert_language(
        "torque/start.cs",
        "function Start(%value) {}",
        SourceLanguage::TorqueScript,
    );
    assert_language(
        "quake/start.qc",
        "void() Start = {};",
        SourceLanguage::QuakeC,
    );
    assert_language(
        "source/start.qc",
        "$modelname \"start.mdl\"",
        SourceLanguage::ValveQc,
    );

    assert_eq!(
        SourceLanguage::for_v1_normalized_path_with_source(
            "DayZ/scripts/4_World/Start.c",
            "modded class Start {}",
        ),
        Some(SourceLanguage::C)
    );
    assert_eq!(
        SourceLanguage::for_v1_normalized_path_with_source(
            "torque/start.cs",
            "function Start(%value) {}",
        ),
        Some(SourceLanguage::CSharp)
    );
    assert_eq!(
        SourceLanguage::detect("generic/test.t", Some("use strict;")),
        None
    );
    assert_eq!(
        SourceLanguage::detect(
            "drivers/setup.inf",
            Some("[Version]\nSignature=\"$Windows NT$\"")
        ),
        None
    );
    assert_eq!(
        SourceLanguage::detect("native/main.d", Some("module main;\nvoid main() {}")),
        None
    );
    assert_eq!(
        SourceLanguage::detect("docs/scenes/readme.txt", Some("plain prose")),
        None
    );
}

fn fixture_source(source: &str) -> String {
    format!("{source}\nsecret = \"{SECRET_SENTINEL} FakeCall()\";\n")
}

fn assert_language(path: &str, source: &str, expected: SourceLanguage) {
    assert_eq!(
        SourceLanguage::for_normalized_path_with_source(path, source),
        Some(expected),
        "{path}"
    );
}

fn snapshot(path: &str, source: &str) -> SourceSnapshot {
    SourceSnapshot::from_bytes(path, source.as_bytes(), limits())
        .unwrap_or_else(|error| panic!("{path} snapshot failed: {error}"))
}

fn limits() -> SourceLimits {
    SourceLimits::new(SOURCE_LIMIT)
        .unwrap_or_else(|error| panic!("game scripting source limit failed: {error}"))
}
