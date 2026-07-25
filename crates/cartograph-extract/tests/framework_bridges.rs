use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolKind};
use cartograph_extract::{NativeExtractor, SourceLimits, SourceSnapshot};

const SOURCE_LIMIT: usize = 1024 * 1024;

#[test]
fn react_native_objc_and_jvm_exports_become_typed_native_methods() {
    let objc = extract(
        "ios/RCTGeolocation.m",
        r#"
@implementation RCTGeolocation
RCT_EXPORT_MODULE(Geolocation)
RCT_EXPORT_METHOD(getCurrentPosition:(RCTResponseSenderBlock)callback) {}
RCT_REMAP_METHOD(compute, nativeCompute:(double)value) {}
RCT_EXPORT_METHOD(addListener:(NSString *)name) {}
@end
"#,
        SourceLanguage::ObjectiveC,
    );
    assert_landmark(&objc, SymbolKind::Resource, "Geolocation");
    assert_landmark(&objc, SymbolKind::Method, "getCurrentPosition");
    assert_landmark(&objc, SymbolKind::Method, "compute");
    assert_no_bridge_landmark(&objc, "addListener");

    let kotlin = extract(
        "android/ScannerModule.kt",
        r#"
class ScannerModule {
  @ReactMethod
  fun startScan() {}

  @ReactMethod
  fun removeListeners(count: Int) {}
}
"#,
        SourceLanguage::Kotlin,
    );
    assert_landmark(&kotlin, SymbolKind::Method, "startScan");
    assert_no_bridge_landmark(&kotlin, "removeListeners");
}

#[test]
fn expo_modules_and_fabric_views_retain_js_visible_members() {
    let swift = extract(
        "ios/HapticsModule.swift",
        r#"
import ExpoModulesCore
public class HapticsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoHaptics")
    AsyncFunction("notificationAsync") { }
    Function("synchronousThing") { }
    Property("isAvailable") { true }
  }
}
"#,
        SourceLanguage::Swift,
    );
    assert_landmark(&swift, SymbolKind::Resource, "ExpoHaptics");
    for member in ["notificationAsync", "synchronousThing", "isAvailable"] {
        assert_landmark(&swift, SymbolKind::Method, member);
    }

    let spec = extract(
        "src/MyViewNativeComponent.ts",
        r#"
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';
interface NativeProps {
  readonly color?: string;
  enabled: boolean;
  onTap?: () => void;
}
export default codegenNativeComponent<NativeProps>('MyView');
"#,
        SourceLanguage::TypeScript,
    );
    assert_landmark(&spec, SymbolKind::Component, "MyView");
    for property in ["color", "enabled", "onTap"] {
        assert_landmark(&spec, SymbolKind::Property, property);
    }

    let objc_view = extract(
        "ios/RNTFooManager.m",
        r#"
@interface RNTFooManager : RCTViewManager
@end
@implementation RNTFooManager
RCT_EXPORT_VIEW_PROPERTY(color, NSString)
RCT_EXPORT_VIEW_PROPERTY(enabled, BOOL)
@end
"#,
        SourceLanguage::ObjectiveC,
    );
    assert_landmark(&objc_view, SymbolKind::Component, "RNTFoo");
    assert_landmark(&objc_view, SymbolKind::Property, "color");
    assert_landmark(&objc_view, SymbolKind::Property, "enabled");

    let kotlin_view = extract(
        "android/FooViewManager.kt",
        r#"
class Helper {}
class FooViewManager : SimpleViewManager<FooView>() {
  @ReactProp(name = "color")
  fun setColor(view: FooView, color: String) {}
}
"#,
        SourceLanguage::Kotlin,
    );
    assert_landmark(&kotlin_view, SymbolKind::Component, "Foo");
    assert_landmark(&kotlin_view, SymbolKind::Property, "color");
}

#[test]
fn javascript_native_calls_emit_bounded_module_and_method_references() {
    let javascript = extract(
        "src/native.ts",
        r#"
import { NativeModules, TurboModuleRegistry } from 'react-native';
NativeModules.Geolocation.getCurrentPosition();
NativeModules.Geolocation.addListener('ignored');
const Device = TurboModuleRegistry.getEnforcing<Spec>('DeviceInfo');
const Haptics = requireNativeModule('ExpoHaptics');
Haptics.notificationAsync();
"#,
        SourceLanguage::TypeScript,
    );
    for module in ["Geolocation", "DeviceInfo", "ExpoHaptics"] {
        assert!(
            javascript.references.iter().any(|reference| {
                reference.kind == ReferenceKind::References && reference.name == module
            }),
            "missing native module reference {module}: {:?}",
            javascript.references
        );
    }
    assert!(javascript.references.iter().any(|reference| {
        reference.kind == ReferenceKind::Calls && reference.name == "getCurrentPosition"
    }));
    for (name, resolution_name) in [
        ("getCurrentPosition", "Geolocation::getCurrentPosition"),
        ("notificationAsync", "ExpoHaptics::notificationAsync"),
    ] {
        assert!(
            javascript.references.iter().any(|reference| {
                reference.kind == ReferenceKind::Calls
                    && reference.name == name
                    && reference.resolution_name.as_deref() == Some(resolution_name)
            }),
            "missing qualified native lookup {resolution_name}: {:?}",
            javascript.references
        );
    }
    assert!(javascript.references.iter().all(|reference| {
        !(reference.kind == ReferenceKind::Calls && reference.name == "addListener")
    }));

    let turbo = extract(
        "src/NativeDeviceInfo.ts",
        r#"
interface Spec extends TurboModule {
  getConstants(): { model: string; version: string };
  ping(value: string): void;
}
export default TurboModuleRegistry.getEnforcing<Spec>('DeviceInfo');
"#,
        SourceLanguage::TypeScript,
    );
    assert_bridge_landmark(&turbo, "getConstants", "turbo-module-spec-method");
    assert_bridge_landmark(&turbo, "ping", "turbo-module-spec-method");
}

#[test]
fn swift_objc_exports_are_explicit_selector_aware_and_comment_safe() {
    let objc = extract(
        "ios/Player.m",
        r#"
@implementation Player
- (void)playWithSong:(NSString *)song {}
- (void)setDisplayName:(NSString *)name {}
// RCT_EXPORT_METHOD(commentedOut:(NSString *)value) {}
@end
"#,
        SourceLanguage::ObjectiveC,
    );
    assert_bridge_landmark(&objc, "play", "objc-swift-method");
    assert_bridge_landmark(&objc, "playWithSong", "objc-swift-method");
    assert_bridge_landmark(&objc, "displayName", "objc-swift-method");
    assert_no_bridge_landmark(&objc, "commentedOut");

    let swift = extract(
        "ios/SwiftPlayer.swift",
        r#"
@objcMembers
class SwiftPlayer {
  func play(song: String) {}
  @nonobjc func internalOnly() {}
}

class ExplicitPlayer {
  @objc(playWithTrack:)
  func perform(track: String) {}
}
"#,
        SourceLanguage::Swift,
    );
    assert_bridge_landmark(&swift, "play", "swift-objc-method");
    assert_bridge_landmark(&swift, "perform", "swift-objc-method");
    assert_bridge_landmark(&swift, "playWithTrack", "swift-objc-method");
    assert_no_bridge_landmark(&swift, "internalOnly");
}

#[test]
fn react_native_event_channels_keep_static_producers_consumers_and_handlers() {
    let javascript = extract(
        "src/events.ts",
        r#"
import { NativeEventEmitter, NativeModules } from 'react-native';
function handleReady() {}
const emitter = new NativeEventEmitter(NativeModules.Device);
emitter.addListener('device.ready', handleReady);
emitter.addListener(dynamicEvent, handleDynamic);
emitter.addListener('secret-token', shouldNeverPersist);
// emitter.addListener('commented.event', commentedHandler);
"#,
        SourceLanguage::TypeScript,
    );
    assert!(javascript.symbols.iter().any(|symbol| {
        symbol.name == "device.ready"
            && symbol
                .qualified_name
                .contains("::react-native-event-consumer::")
    }));
    assert!(javascript.references.iter().any(|reference| {
        reference.name == "handleReady" && reference.kind == ReferenceKind::Calls
    }));
    for absent in ["secret-token", "commented.event"] {
        assert!(
            javascript
                .symbols
                .iter()
                .all(|symbol| symbol.name != absent),
            "unsafe or commented event leaked: {javascript:?}"
        );
    }

    let objc = extract(
        "ios/DeviceEmitter.m",
        r#"
@implementation DeviceEmitter
- (void)ready { [self sendEventWithName:@"device.ready" body:nil]; }
@end
"#,
        SourceLanguage::ObjectiveC,
    );
    let swift = extract(
        "ios/SyncEmitter.swift",
        r#"
class SyncEmitter: RCTEventEmitter {
  func publish() { sendEvent(withName: "sync.finished", body: nil) }
}
"#,
        SourceLanguage::Swift,
    );
    let kotlin = extract(
        "android/DeviceModule.kt",
        r#"
class DeviceModule {
  fun publish() {
    reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("device.ready", null)
  }
}
"#,
        SourceLanguage::Kotlin,
    );
    for (extracted, event) in [
        (&objc, "device.ready"),
        (&swift, "sync.finished"),
        (&kotlin, "device.ready"),
    ] {
        assert!(
            extracted.symbols.iter().any(|symbol| {
                symbol.name == event
                    && symbol
                        .qualified_name
                        .contains("::react-native-event-producer::")
            }),
            "missing native event producer {event}: {extracted:?}"
        );
    }
}

fn assert_landmark(extracted: &cartograph_extract::ExtractedFile, kind: SymbolKind, name: &str) {
    assert!(
        extracted
            .symbols
            .iter()
            .any(|symbol| symbol.kind == kind && symbol.name == name),
        "missing {kind:?} {name}: {extracted:?}"
    );
}

fn assert_no_bridge_landmark(extracted: &cartograph_extract::ExtractedFile, name: &str) {
    assert!(
        extracted.symbols.iter().all(|symbol| {
            symbol.name != name
                || (!symbol.qualified_name.contains("react-native-method")
                    && !symbol.qualified_name.contains("expo-module-method")
                    && !symbol.qualified_name.contains("objc-swift-method")
                    && !symbol.qualified_name.contains("swift-objc-method"))
        }),
        "unexpected synthetic bridge landmark {name}: {extracted:?}"
    );
}

fn assert_bridge_landmark(
    extracted: &cartograph_extract::ExtractedFile,
    name: &str,
    category: &str,
) {
    assert!(
        extracted.symbols.iter().any(|symbol| {
            symbol.name == name && symbol.qualified_name.contains(&format!("::{category}::"))
        }),
        "missing synthetic bridge landmark {category} {name}: {extracted:?}"
    );
}

fn extract(
    path: &str,
    source: &str,
    language: SourceLanguage,
) -> cartograph_extract::ExtractedFile {
    let limits = SourceLimits::new(SOURCE_LIMIT)
        .unwrap_or_else(|error| panic!("source limits failed: {error}"));
    let snapshot = SourceSnapshot::from_bytes(path, source.as_bytes(), limits)
        .unwrap_or_else(|error| panic!("snapshot failed for {path}: {error}"));
    assert_eq!(snapshot.language(), language, "{path}");
    let mut extractor = NativeExtractor::new(language)
        .unwrap_or_else(|error| panic!("extractor failed for {path}: {error}"));
    extractor
        .extract(&snapshot)
        .unwrap_or_else(|error| panic!("extraction failed for {path}: {error}"))
}
