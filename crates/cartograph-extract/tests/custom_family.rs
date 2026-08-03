//! Integration coverage for Cartograph native extraction contracts.

mod dependency_ownership;

use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolKind};
use cartograph_extract::{ExtractError, NativeExtractor, SourceLimits, SourceSnapshot};

const SOURCE_LIMIT: usize = 1024 * 1024;
const SECRET_SENTINEL: &str = "cartograph_literal_secret_sentinel_7c1f";

struct Fixture {
    language: SourceLanguage,
    path: &'static str,
    source: &'static str,
    symbol_kind: SymbolKind,
    symbol_name: &'static str,
    reference: Option<(&'static str, ReferenceKind)>,
}

const FIXTURES: [Fixture; 13] = [
    Fixture {
        language: SourceLanguage::Aura,
        path: "force-app/main/default/aura/OrderPanel/OrderPanel.cmp",
        source: "<aura:component controller=\"OrderController\"><aura:attribute name=\"orderId\" type=\"Id\"/><c:orderCard onclick=\"{!c.loadOrder}\"/><span data-secret=\"cartograph_literal_secret_sentinel_7c1f\"/></aura:component>\n",
        symbol_kind: SymbolKind::Field,
        symbol_name: "orderId",
        reference: Some(("loadOrder", ReferenceKind::Calls)),
    },
    Fixture {
        language: SourceLanguage::Bg3Anubis,
        path: "Game/AI/order.ann",
        source: "game.states.OrderState = State {\n nodes.LoadOrder = Action {\n OnEnter = function()\n   StartOrder()\n end\n}\n",
        symbol_kind: SymbolKind::Module,
        symbol_name: "OrderState",
        reference: Some(("StartOrder", ReferenceKind::Calls)),
    },
    Fixture {
        language: SourceLanguage::Bg3Resource,
        path: "Mods/Orders/Public/Data/order.lsx",
        source: "<save><region id=\"Orders\"><node id=\"OrderDefinition\"><attribute id=\"Name\" value=\"OrderBeacon\"/><attribute id=\"ParentTemplateId\" value=\"OrderParent_123\"/><attribute id=\"Secret\" value=\"cartograph_literal_secret_sentinel_7c1f\"/></node></region></save>\n",
        symbol_kind: SymbolKind::Resource,
        symbol_name: "OrderBeacon",
        reference: Some(("OrderParent_123", ReferenceKind::References)),
    },
    Fixture {
        language: SourceLanguage::Bg3Stats,
        path: "Game/Stats/Generated/Data/orders.txt",
        source: "new entry \"OrderStatsBeacon\"\ntype \"StatusData\"\nusing \"BaseOrderStats\"\ndata \"Boosts\" \"OrderBoost_123;cartograph_literal_secret_sentinel_7c1f\"\n",
        symbol_kind: SymbolKind::Resource,
        symbol_name: "OrderStatsBeacon",
        reference: Some(("BaseOrderStats", ReferenceKind::Extends)),
    },
    Fixture {
        language: SourceLanguage::Liquid,
        path: "sections/order-panel.liquid",
        source: "{% assign order_total = cart.total %}\n{% render 'order-card' %}\n{{ format_order(order_total) }}\n{% comment %}cartograph_literal_secret_sentinel_7c1f{% endcomment %}\n",
        symbol_kind: SymbolKind::Variable,
        symbol_name: "order_total",
        reference: Some(("snippets/order-card.liquid", ReferenceKind::Imports)),
    },
    Fixture {
        language: SourceLanguage::Osiris,
        path: "Story/RawFiles/Goals/OrderGoal.txt",
        source: "INITSECTION\nsyscall StartOrder((GUIDSTRING)_Order)\nKBSECTION\nIF\nDB_OrderReady(_Order)\nTHEN\nStartOrder(_Order);\n",
        symbol_kind: SymbolKind::Function,
        symbol_name: "StartOrder",
        reference: Some(("DB_OrderReady", ReferenceKind::References)),
    },
    Fixture {
        language: SourceLanguage::Properties,
        path: "config/application.properties",
        source: "orders.cache.ttl=${orders.default.ttl}\norders.secret=cartograph_literal_secret_sentinel_7c1f\n",
        symbol_kind: SymbolKind::Constant,
        symbol_name: "orders.cache.ttl",
        reference: Some(("orders.default.ttl", ReferenceKind::References)),
    },
    Fixture {
        language: SourceLanguage::Rhai,
        path: "scripts/order-policy.rhai",
        source: "import \"./orders\" as orders;\nfn load_order(id) { orders::fetch(id) }\nconst secret = \"cartograph_literal_secret_sentinel_7c1f\";\n",
        symbol_kind: SymbolKind::Function,
        symbol_name: "load_order",
        reference: Some(("orders::fetch", ReferenceKind::Calls)),
    },
    Fixture {
        language: SourceLanguage::Svelte,
        path: "src/OrderPanel.svelte",
        source: "<script lang=\"ts\">\nimport OrderCard from './OrderCard.svelte';\nexport function loadOrder() { fetchOrder(); }\nconst secret = 'cartograph_literal_secret_sentinel_7c1f';\n</script>\n<OrderCard on:click=\"loadOrder()\" />\n{formatOrder(order)}\n",
        symbol_kind: SymbolKind::Component,
        symbol_name: "OrderPanel",
        reference: Some(("fetchOrder", ReferenceKind::Calls)),
    },
    Fixture {
        language: SourceLanguage::Vb6,
        path: "legacy/OrderModule.bas",
        source: "Attribute VB_Name = \"OrderModule\"\nPublic Type OrderRecord\n  Id As Long\nEnd Type\nPublic Sub LoadOrder()\n  FetchOrder (1)\n  secret = \"cartograph_literal_secret_sentinel_7c1f\"\nEnd Sub\n",
        symbol_kind: SymbolKind::Struct,
        symbol_name: "OrderRecord",
        reference: Some(("FetchOrder", ReferenceKind::Calls)),
    },
    Fixture {
        language: SourceLanguage::Visualforce,
        path: "force-app/main/default/pages/Orders.page",
        source: "<apex:page controller=\"OrderController\" action=\"{!loadOrders}\"><c:orderTable/><span title=\"cartograph_literal_secret_sentinel_7c1f\"/></apex:page>\n",
        symbol_kind: SymbolKind::Route,
        symbol_name: "/apex/Orders",
        reference: Some(("loadOrders", ReferenceKind::Calls)),
    },
    Fixture {
        language: SourceLanguage::Vue,
        path: "src/OrderPanel.vue",
        source: "<script setup lang=\"ts\">\nimport OrderCard from './OrderCard.vue';\nexport function loadOrder() { fetchOrder(); }\nconst secret = 'cartograph_literal_secret_sentinel_7c1f';\n</script>\n<template><OrderCard @click=\"loadOrder()\" />{{ formatOrder(order) }}</template>\n",
        symbol_kind: SymbolKind::Component,
        symbol_name: "OrderPanel",
        reference: Some(("fetchOrder", ReferenceKind::Calls)),
    },
    Fixture {
        language: SourceLanguage::Xml,
        path: "src/main/resources/OrderMapper.xml",
        source: "<mapper namespace=\"com.example.OrderMapper\"><resultMap id=\"orderMap\" type=\"com.example.Order\"/><sql id=\"orderColumns\">id,total</sql><select id=\"findOrder\" resultMap=\"orderMap\">SELECT <include refid=\"orderColumns\"/> FROM orders WHERE id = #{orderId} AND secret != 'cartograph_literal_secret_sentinel_7c1f'</select></mapper>\n",
        symbol_kind: SymbolKind::Method,
        symbol_name: "findOrder",
        reference: Some(("OrderMapper::orderColumns", ReferenceKind::References)),
    },
];

#[test]
fn custom_modes_extract_real_structures_deterministically_without_literal_leaks() {
    for fixture in FIXTURES {
        let snapshot =
            SourceSnapshot::from_bytes(fixture.path, fixture.source.as_bytes(), limits())
                .unwrap_or_else(|error| panic!("{} snapshot failed: {error}", fixture.path));
        assert_eq!(snapshot.language(), fixture.language, "{}", fixture.path);
        assert!(fixture.language.is_native_indexable(), "{}", fixture.path);
        let mut extractor = NativeExtractor::new(fixture.language)
            .unwrap_or_else(|error| panic!("{} extractor failed: {error}", fixture.path));
        let first = extractor
            .extract(&snapshot)
            .unwrap_or_else(|error| panic!("{} extraction failed: {error}", fixture.path));
        let second = extractor
            .extract(&snapshot)
            .unwrap_or_else(|error| panic!("{} repeat failed: {error}", fixture.path));
        assert_eq!(first, second, "{} was not deterministic", fixture.path);
        assert!(
            first.symbols.iter().any(|symbol| {
                symbol.kind == fixture.symbol_kind && symbol.name == fixture.symbol_name
            }),
            "{} missing {:?} {}; symbols={:?}",
            fixture.path,
            fixture.symbol_kind,
            fixture.symbol_name,
            first
                .symbols
                .iter()
                .map(|symbol| (
                    symbol.kind,
                    symbol.name.as_str(),
                    symbol.qualified_name.as_str()
                ))
                .collect::<Vec<_>>()
        );
        if let Some((name, kind)) = fixture.reference {
            assert!(
                first
                    .references
                    .iter()
                    .any(|reference| reference.name == name && reference.kind == kind),
                "{} missing {kind:?} {name}; refs={:?}",
                fixture.path,
                first.references
            );
        }
        assert!(
            !format!("{first:?}").contains(SECRET_SENTINEL),
            "{} leaked a source literal",
            fixture.path
        );
    }
}

#[test]
fn custom_modes_poll_cancellation_before_retaining_facts() {
    for fixture in FIXTURES {
        let snapshot =
            SourceSnapshot::from_bytes(fixture.path, fixture.source.as_bytes(), limits())
                .unwrap_or_else(|error| panic!("{} snapshot failed: {error}", fixture.path));
        let mut extractor = NativeExtractor::new(fixture.language)
            .unwrap_or_else(|error| panic!("{} extractor failed: {error}", fixture.path));
        assert_eq!(
            extractor.extract_with_cancellation(&snapshot, || true),
            Err(ExtractError::Cancelled),
            "{}",
            fixture.path
        );
    }
}

fn limits() -> SourceLimits {
    SourceLimits::new(SOURCE_LIMIT)
        .unwrap_or_else(|error| panic!("custom-family source limit failed: {error}"))
}
