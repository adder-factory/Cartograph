/**
 * Framework Resolver Registry
 *
 * Manages framework-specific resolvers.
 */

import type { FrameworkResolver, ResolutionContext } from '../types.js';
import { drupalResolver } from './drupal.js';
import { laravelResolver } from './laravel.js';
import { expressResolver } from './express.js';
import { bunServeResolver } from './bun-serve.js';
import { reactResolver } from './react.js';
import { svelteResolver } from './svelte.js';
import { vueResolver } from './vue.js';
import { djangoResolver, flaskResolver, fastapiResolver } from './python.js';
import { railsResolver } from './ruby.js';
import { springResolver } from './java.js';
import { goResolver } from './go.js';
import { rustResolver } from './rust.js';
import { playResolver } from './play.js';
import { aspnetResolver } from './csharp.js';
import { swiftUIResolver, uikitResolver, vaporResolver } from './swift.js';
import { swiftObjcBridgeResolver } from './swift-objc.js';
import { reactNativeBridgeResolver } from './react-native.js';
import { expoModulesResolver } from './expo-modules.js';
import { fabricViewResolver } from './fabric.js';
import { cliCommanderResolver } from './cli.js';

/**
 * All registered framework resolvers
 */
const FRAMEWORK_RESOLVERS: FrameworkResolver[] = [
  // PHP
  laravelResolver,
  drupalResolver,
  // JavaScript/TypeScript
  expressResolver,
  bunServeResolver,
  reactResolver,
  svelteResolver,
  vueResolver,
  cliCommanderResolver,
  // Python
  djangoResolver,
  flaskResolver,
  fastapiResolver,
  // Ruby
  railsResolver,
  // Java
  springResolver,
  playResolver,
  // Go
  goResolver,
  // Rust
  rustResolver,
  // C#
  aspnetResolver,
  // Swift
  swiftUIResolver,
  uikitResolver,
  vaporResolver,
  // Swift ↔ Objective-C bridge (cross-language; runs only when a project
  // has both .swift and .m/.mm source — B12 sub-channel 1).
  swiftObjcBridgeResolver,
  // React Native JS ↔ native bridge (legacy + TurboModules; runs on RN
  // projects — B12 sub-channel 2).
  reactNativeBridgeResolver,
  // Expo Modules JS ↔ native bridge (Swift/Kotlin Module DSL — B12 sub-channel 3).
  expoModulesResolver,
  // Fabric + legacy Paper view components (Codegen specs + RCT_EXPORT_VIEW_PROPERTY
  // / @ReactProp → component+property nodes — B12 sub-channel 4). The
  // component→native-class bridge edge is the fabric-native-impl index-hook.
  fabricViewResolver,
];

/**
 * Get all framework resolvers
 */
export function getAllFrameworkResolvers(): FrameworkResolver[] {
  return FRAMEWORK_RESOLVERS;
}

/**
 * Detect which frameworks are used in a project
 */
export function detectFrameworks(context: ResolutionContext): FrameworkResolver[] {
  return FRAMEWORK_RESOLVERS.filter((resolver) => {
    try {
      return resolver.detect(context);
    } catch {
      return false;
    }
  });
}

// Re-export framework resolvers
export { laravelResolver, FACADE_MAPPINGS } from './laravel.js';
export { expressResolver } from './express.js';
export { bunServeResolver } from './bun-serve.js';
export { reactResolver } from './react.js';
export { svelteResolver } from './svelte.js';
export { vueResolver } from './vue.js';
export { djangoResolver, flaskResolver, fastapiResolver } from './python.js';
export { railsResolver } from './ruby.js';
export { springResolver } from './java.js';
export { playResolver } from './play.js';
export { goResolver } from './go.js';
export { rustResolver } from './rust.js';
export { aspnetResolver } from './csharp.js';
export { swiftUIResolver, uikitResolver, vaporResolver } from './swift.js';
export { cliCommanderResolver } from './cli.js';
