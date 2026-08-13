#include "conversions.hpp"

#include <cmath>
#include <cstring>
#include <limits>

namespace braindump_napi {
namespace {

// Ordinal counts are derived from the last enumerator in the public header so
// that adding a kind there cannot leave these messages stale.
constexpr std::uint8_t kNodeKindCount =
    static_cast<std::uint8_t>(braindump::NodeKind::Metric) + 1;
constexpr std::uint8_t kRelationKindCount =
    static_cast<std::uint8_t>(braindump::RelationKind::Mentions) + 1;

std::string nodeKindNames() {
  std::string names;
  for (std::uint8_t ordinal = 0; ordinal < kNodeKindCount; ++ordinal) {
    if (ordinal > 0) {
      names += ", ";
    }
    names += braindump::toString(static_cast<braindump::NodeKind>(ordinal));
  }
  return names;
}

std::string relationKindNames() {
  std::string names;
  for (std::uint8_t ordinal = 0; ordinal < kRelationKindCount; ++ordinal) {
    if (ordinal > 0) {
      names += ", ";
    }
    names += braindump::toString(static_cast<braindump::RelationKind>(ordinal));
  }
  return names;
}

bool isAbsent(const Napi::Value& value) {
  return value.IsUndefined() || value.IsNull();
}

double integralInRange(const Napi::CallbackInfo& info,
                       std::size_t index,
                       const char* name,
                       double minimum,
                       double maximum) {
  const double raw = requireFiniteNumber(info, index, name);
  if (raw != std::trunc(raw)) {
    throw Napi::RangeError::New(info.Env(),
                                std::string(name) + " must be an integer");
  }
  if (raw < minimum || raw > maximum) {
    throw Napi::RangeError::New(info.Env(),
                                std::string(name) + " must be between " +
                                    std::to_string(static_cast<long long>(minimum)) +
                                    " and " +
                                    std::to_string(static_cast<long long>(maximum)));
  }
  return raw;
}

double patchedField(const Napi::Object& patch, const char* key, double current) {
  const Napi::Value value = patch.Get(key);
  if (isAbsent(value)) {
    return current;
  }
  if (!value.IsNumber()) {
    throw Napi::TypeError::New(
        patch.Env(), std::string("layout param '") + key + "' must be a number");
  }
  const double next = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(next)) {
    throw Napi::RangeError::New(
        patch.Env(), std::string("layout param '") + key + "' must be finite");
  }
  return next;
}

}  // namespace

// ---------------------------------------------------------------------------
// Argument readers
// ---------------------------------------------------------------------------

std::string requireString(const Napi::CallbackInfo& info,
                          std::size_t index,
                          const char* name) {
  const Napi::Value value = info[index];
  if (!value.IsString()) {
    throw Napi::TypeError::New(info.Env(),
                               std::string(name) + " must be a string");
  }
  return value.As<Napi::String>().Utf8Value();
}

double requireFiniteNumber(const Napi::CallbackInfo& info,
                           std::size_t index,
                           const char* name) {
  const Napi::Value value = info[index];
  if (!value.IsNumber()) {
    throw Napi::TypeError::New(info.Env(),
                               std::string(name) + " must be a number");
  }
  const double raw = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(raw)) {
    throw Napi::RangeError::New(info.Env(),
                                std::string(name) + " must be a finite number");
  }
  return raw;
}

bool optionalBool(const Napi::CallbackInfo& info,
                  std::size_t index,
                  const char* name,
                  bool fallback) {
  const Napi::Value value = info[index];
  if (isAbsent(value)) {
    return fallback;
  }
  if (!value.IsBoolean()) {
    throw Napi::TypeError::New(info.Env(),
                               std::string(name) + " must be a boolean");
  }
  return value.As<Napi::Boolean>().Value();
}

int optionalInt(const Napi::CallbackInfo& info,
                std::size_t index,
                const char* name,
                int fallback,
                int minimum) {
  if (isAbsent(info[index])) {
    return fallback;
  }
  const double raw = integralInRange(
      info, index, name, static_cast<double>(minimum),
      static_cast<double>(std::numeric_limits<int>::max()));
  return static_cast<int>(raw);
}

std::uint32_t optionalUint32(const Napi::CallbackInfo& info,
                             std::size_t index,
                             const char* name,
                             std::uint32_t fallback) {
  if (isAbsent(info[index])) {
    return fallback;
  }
  const double raw = integralInRange(
      info, index, name, 0.0,
      static_cast<double>(std::numeric_limits<std::uint32_t>::max()));
  return static_cast<std::uint32_t>(raw);
}

double optionalPositiveNumber(const Napi::CallbackInfo& info,
                              std::size_t index,
                              const char* name,
                              double fallback) {
  if (isAbsent(info[index])) {
    return fallback;
  }
  const double raw = requireFiniteNumber(info, index, name);
  if (raw <= 0.0) {
    throw Napi::RangeError::New(info.Env(),
                                std::string(name) + " must be greater than 0");
  }
  return raw;
}

braindump::NodeKind requireNodeKind(const Napi::CallbackInfo& info,
                                    std::size_t index,
                                    const char* name) {
  const std::string raw = requireString(info, index, name);
  try {
    return braindump::nodeKindFromString(raw);
  } catch (const std::exception&) {
    throw Napi::TypeError::New(info.Env(),
                               std::string(name) + " must be one of: " +
                                   nodeKindNames() + " (received \"" + raw + "\")");
  }
}

braindump::RelationKind requireRelationKind(const Napi::CallbackInfo& info,
                                            std::size_t index,
                                            const char* name) {
  const std::string raw = requireString(info, index, name);
  try {
    return braindump::relationKindFromString(raw);
  } catch (const std::exception&) {
    throw Napi::TypeError::New(info.Env(),
                               std::string(name) + " must be one of: " +
                                   relationKindNames() + " (received \"" + raw +
                                   "\")");
  }
}

std::string requireJsonArgument(const Napi::CallbackInfo& info,
                                std::size_t index,
                                const char* name) {
  const Napi::Env env = info.Env();
  const Napi::Value value = info[index];
  if (value.IsString()) {
    return value.As<Napi::String>().Utf8Value();
  }
  if (!value.IsObject()) {
    throw Napi::TypeError::New(
        env, std::string(name) + " must be an object or a JSON string");
  }

  const Napi::Object json = env.Global().Get("JSON").As<Napi::Object>();
  const Napi::Function stringify = json.Get("stringify").As<Napi::Function>();
  const Napi::Value serialized = stringify.Call(json, {value});
  if (!serialized.IsString()) {
    throw Napi::TypeError::New(
        env, std::string(name) + " could not be serialized to JSON");
  }
  return serialized.As<Napi::String>().Utf8Value();
}

braindump::LayoutParams mergeLayoutParams(
    const Napi::CallbackInfo& info,
    std::size_t index,
    const char* name,
    const braindump::LayoutParams& current) {
  const Napi::Value value = info[index];
  if (!value.IsObject()) {
    throw Napi::TypeError::New(info.Env(),
                               std::string(name) + " must be an object");
  }
  const Napi::Object patch = value.As<Napi::Object>();

  braindump::LayoutParams merged = current;
  merged.repulsion = patchedField(patch, "repulsion", current.repulsion);
  merged.attraction = patchedField(patch, "attraction", current.attraction);
  merged.gravity = patchedField(patch, "gravity", current.gravity);
  merged.damping = patchedField(patch, "damping", current.damping);
  merged.theta = patchedField(patch, "theta", current.theta);
  merged.linkDistance = patchedField(patch, "linkDistance", current.linkDistance);
  return merged;
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

Napi::Value toStringArray(Napi::Env env, const std::vector<std::string>& values) {
  Napi::Array array = Napi::Array::New(env, values.size());
  for (std::size_t i = 0; i < values.size(); ++i) {
    array.Set(static_cast<std::uint32_t>(i), Napi::String::New(env, values[i]));
  }
  return array;
}

Napi::Value toStringMatrix(Napi::Env env,
                           const std::vector<std::vector<std::string>>& groups) {
  Napi::Array array = Napi::Array::New(env, groups.size());
  for (std::size_t i = 0; i < groups.size(); ++i) {
    array.Set(static_cast<std::uint32_t>(i), toStringArray(env, groups[i]));
  }
  return array;
}

Napi::Value toLayoutFrame(Napi::Env env, const braindump::LayoutFrame& frame) {
  const std::size_t length = frame.positions.size();
  const std::size_t byteLength = length * sizeof(double);

  Napi::ArrayBuffer buffer = Napi::ArrayBuffer::New(env, byteLength);
  if (length > 0) {
    std::memcpy(buffer.Data(), frame.positions.data(), byteLength);
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("positions", Napi::Float64Array::New(env, length, buffer, 0));
  result.Set("energy", Napi::Number::New(env, frame.energy));
  result.Set("converged", Napi::Boolean::New(env, frame.converged));
  result.Set("iterations", Napi::Number::New(env, frame.iterations));
  return result;
}

Napi::Value toMergeReport(Napi::Env env, const braindump::MergeReport& report) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("nodesAdded", Napi::Number::New(env, report.nodesAdded));
  result.Set("nodesMerged", Napi::Number::New(env, report.nodesMerged));
  result.Set("edgesAdded", Napi::Number::New(env, report.edgesAdded));
  result.Set("edgesMerged", Napi::Number::New(env, report.edgesMerged));
  result.Set("affectedNodeIds", toStringArray(env, report.affectedNodeIds));
  return result;
}

Napi::Value toLinkSyncReport(Napi::Env env,
                             const braindump::LinkSyncReport& report) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("createdNodeIds", toStringArray(env, report.createdNodeIds));
  result.Set("orphanedNodeIds", toStringArray(env, report.orphanedNodeIds));
  result.Set("linkedNodeIds", toStringArray(env, report.linkedNodeIds));
  return result;
}

Napi::Value toSearchHits(Napi::Env env,
                         const std::vector<braindump::SearchHit>& hits) {
  Napi::Array array = Napi::Array::New(env, hits.size());
  for (std::size_t i = 0; i < hits.size(); ++i) {
    Napi::Object hit = Napi::Object::New(env);
    hit.Set("nodeId", Napi::String::New(env, hits[i].nodeId));
    hit.Set("label", Napi::String::New(env, hits[i].label));
    hit.Set("score", Napi::Number::New(env, hits[i].score));
    array.Set(static_cast<std::uint32_t>(i), hit);
  }
  return array;
}

}  // namespace braindump_napi
