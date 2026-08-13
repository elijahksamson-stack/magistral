// JS <-> native marshalling for the BrainDump addon.
//
// Argument readers validate at the boundary and throw Napi::TypeError /
// Napi::RangeError with an actionable message; result builders shape the
// plain objects declared in shared/types/addon.ts.

#ifndef BRAINDUMP_NAPI_CONVERSIONS_HPP
#define BRAINDUMP_NAPI_CONVERSIONS_HPP

#include <napi.h>

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "braindump/braindump.hpp"

namespace braindump_napi {

// ---------------------------------------------------------------------------
// Argument readers
// ---------------------------------------------------------------------------

std::string requireString(const Napi::CallbackInfo& info,
                          std::size_t index,
                          const char* name);

double requireFiniteNumber(const Napi::CallbackInfo& info,
                           std::size_t index,
                           const char* name);

/** Absent, undefined, or null yields `fallback`. */
bool optionalBool(const Napi::CallbackInfo& info,
                  std::size_t index,
                  const char* name,
                  bool fallback);

/** Integral, within [minimum, INT32_MAX]. Absent/undefined/null -> fallback. */
int optionalInt(const Napi::CallbackInfo& info,
                std::size_t index,
                const char* name,
                int fallback,
                int minimum);

/** Integral, within [0, UINT32_MAX]. Absent/undefined/null -> fallback. */
std::uint32_t optionalUint32(const Napi::CallbackInfo& info,
                             std::size_t index,
                             const char* name,
                             std::uint32_t fallback);

/** Finite and strictly positive. Absent/undefined/null -> fallback. */
double optionalPositiveNumber(const Napi::CallbackInfo& info,
                              std::size_t index,
                              const char* name,
                              double fallback);

braindump::NodeKind requireNodeKind(const Napi::CallbackInfo& info,
                                    std::size_t index,
                                    const char* name);

braindump::RelationKind requireRelationKind(const Napi::CallbackInfo& info,
                                            std::size_t index,
                                            const char* name);

/**
 * Accepts an object (serialized with the runtime's JSON.stringify) or a
 * pre-serialized JSON string. The core owns schema validation.
 */
std::string requireJsonArgument(const Napi::CallbackInfo& info,
                                std::size_t index,
                                const char* name);

/** Copy of `current` with every finite number present in the patch applied. */
braindump::LayoutParams mergeLayoutParams(const Napi::CallbackInfo& info,
                                          std::size_t index,
                                          const char* name,
                                          const braindump::LayoutParams& current);

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

Napi::Value toStringArray(Napi::Env env, const std::vector<std::string>& values);

Napi::Value toStringMatrix(Napi::Env env,
                           const std::vector<std::vector<std::string>>& groups);

/**
 * LayoutFrame with `positions` as a Float64Array over a fresh ArrayBuffer.
 * Exactly one memcpy of the flat double buffer per tick — no per-node JS
 * objects, no id strings. See the design note in shared/types/addon.ts.
 */
Napi::Value toLayoutFrame(Napi::Env env, const braindump::LayoutFrame& frame);

Napi::Value toMergeReport(Napi::Env env, const braindump::MergeReport& report);

Napi::Value toLinkSyncReport(Napi::Env env,
                             const braindump::LinkSyncReport& report);

Napi::Value toSearchHits(Napi::Env env,
                         const std::vector<braindump::SearchHit>& hits);

}  // namespace braindump_napi

#endif  // BRAINDUMP_NAPI_CONVERSIONS_HPP
