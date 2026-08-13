// BrainDump native addon entry point.
//
// Implements BrainDumpCoreAddon from shared/types/addon.ts. The graph class
// itself lives in graph_wrap.cpp; this file only wires up the module surface.

#include <napi.h>

#include <memory>
#include <utility>

#include "addon_data.hpp"
#include "braindump/braindump.hpp"
#include "conversions.hpp"
#include "graph_wrap.hpp"
#include "guard.hpp"

namespace braindump_napi {
namespace {

Napi::Value CreateGraph(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string name = requireString(info, 0, "name");
  return guarded(env, [&]() -> Napi::Value {
    return GraphWrap::Create(env, std::make_unique<braindump::Graph>(name));
  });
}

Napi::Value GraphFromJSON(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string json = requireString(info, 0, "json");
  return guarded(env, [&]() -> Napi::Value {
    return GraphWrap::Create(
        env, std::make_unique<braindump::Graph>(braindump::Graph::fromJSON(json)));
  });
}

Napi::Value Version(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  return guarded(env, [&]() -> Napi::Value {
    const char* semver = braindump::version();
    if (semver == nullptr) {
      throw Napi::Error::New(env, "braindump: core version() returned null");
    }
    return Napi::String::New(env, semver);
  });
}

Napi::Value SchemaVersion(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), braindump::kSchemaVersion);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  const Napi::Function graphConstructor = GraphWrap::Init(env);
  env.SetInstanceData(new AddonData{Napi::Persistent(graphConstructor)});

  exports.Set("createGraph", Napi::Function::New(env, CreateGraph, "createGraph"));
  exports.Set("graphFromJSON",
              Napi::Function::New(env, GraphFromJSON, "graphFromJSON"));
  exports.Set("version", Napi::Function::New(env, Version, "version"));
  exports.Set("schemaVersion",
              Napi::Function::New(env, SchemaVersion, "schemaVersion"));
  return exports;
}

}  // namespace
}  // namespace braindump_napi

// NODE_API_MODULE token-pastes the registration function name, so it needs an
// unqualified identifier at global scope.
static Napi::Object InitBrainDumpAddon(Napi::Env env, Napi::Object exports) {
  return braindump_napi::Init(env, exports);
}

NODE_API_MODULE(braindump, InitBrainDumpAddon)
