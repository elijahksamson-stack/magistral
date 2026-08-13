/**
 * Types for the BrainDump native addon loader (bindings/napi/index.js).
 *
 * The runtime surface is implemented in C++ (bindings/napi/addon.cpp); the
 * shapes are re-exported from the shared contract so consumers never restate
 * them.
 */

import type { BrainDumpCoreAddon, LayoutFrame, NativeGraph } from '../../shared/types/addon';

export type { BrainDumpCoreAddon, LayoutFrame, NativeGraph };

/** Create an empty graph. */
export declare const createGraph: BrainDumpCoreAddon['createGraph'];

/** Parse a graph from canonical JSON. Throws on schema mismatch. */
export declare const graphFromJSON: BrainDumpCoreAddon['graphFromJSON'];

/** Semver of the compiled core, for diagnostics. */
export declare const version: BrainDumpCoreAddon['version'];

/** Schema version the core reads and writes. Must equal SCHEMA_VERSION. */
export declare const schemaVersion: BrainDumpCoreAddon['schemaVersion'];
