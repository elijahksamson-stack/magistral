// PRIVATE. Boundary validation for every JSON payload the core accepts.
//
// shared/schema/graph.schema.json sets additionalProperties:false everywhere,
// so unknown keys are an error here too — a silently ignored key is a silently
// lost edit.

#ifndef BRAINDUMP_SRC_JSON_UTIL_HPP
#define BRAINDUMP_SRC_JSON_UTIL_HPP

#include <braindump/braindump.hpp>
#include <nlohmann/json.hpp>

#include <initializer_list>
#include <optional>
#include <string>

namespace braindump {
namespace internal {

/** Insertion-ordered so the canonical writer controls key order. */
using Json = nlohmann::ordered_json;

[[noreturn]] inline void failValidation(const std::string& message) {
  throw GraphError(message);
}

inline void expectObject(const Json& value, const std::string& context) {
  if (!value.is_object()) {
    failValidation(context + " must be an object");
  }
}

inline void expectArray(const Json& value, const std::string& context) {
  if (!value.is_array()) {
    failValidation(context + " must be an array");
  }
}

inline void rejectUnknownKeys(const Json& object,
                              std::initializer_list<const char*> allowed,
                              const std::string& context) {
  for (auto it = object.begin(); it != object.end(); ++it) {
    bool isAllowed = false;
    for (const char* candidate : allowed) {
      if (it.key() == candidate) {
        isAllowed = true;
        break;
      }
    }
    if (!isAllowed) {
      failValidation(context + " has unknown property '" + it.key() + "'");
    }
  }
}

inline const Json& requireMember(const Json& object, const char* key,
                                 const std::string& context) {
  const auto found = object.find(key);
  if (found == object.end()) {
    failValidation(context + " is missing required property '" +
                   std::string(key) + "'");
  }
  return *found;
}

inline std::string requireString(const Json& object, const char* key,
                                 const std::string& context) {
  const Json& value = requireMember(object, key, context);
  if (!value.is_string()) {
    failValidation(context + "." + key + " must be a string");
  }
  return value.get<std::string>();
}

inline std::string requireNonEmptyString(const Json& object, const char* key,
                                         const std::string& context) {
  std::string value = requireString(object, key, context);
  if (value.empty()) {
    failValidation(context + "." + key + " must not be empty");
  }
  return value;
}

inline double requireNumber(const Json& object, const char* key,
                            const std::string& context) {
  const Json& value = requireMember(object, key, context);
  if (!value.is_number()) {
    failValidation(context + "." + key + " must be a number");
  }
  return value.get<double>();
}

inline int requireInteger(const Json& object, const char* key,
                          const std::string& context) {
  const Json& value = requireMember(object, key, context);
  if (!value.is_number_integer()) {
    failValidation(context + "." + key + " must be an integer");
  }
  return value.get<int>();
}

inline bool requireBoolean(const Json& object, const char* key,
                           const std::string& context) {
  const Json& value = requireMember(object, key, context);
  if (!value.is_boolean()) {
    failValidation(context + "." + key + " must be a boolean");
  }
  return value.get<bool>();
}

inline std::optional<std::string> optionalString(const Json& object,
                                                 const char* key,
                                                 const std::string& context) {
  const auto found = object.find(key);
  if (found == object.end()) {
    return std::nullopt;
  }
  if (!found->is_string()) {
    failValidation(context + "." + std::string(key) + " must be a string");
  }
  return found->get<std::string>();
}

inline double optionalPositiveNumber(const Json& object, const char* key,
                                     double fallback, const std::string& context) {
  const auto found = object.find(key);
  if (found == object.end()) {
    return fallback;
  }
  if (!found->is_number()) {
    failValidation(context + "." + std::string(key) + " must be a number");
  }
  const double value = found->get<double>();
  if (!(value > 0.0)) {
    failValidation(context + "." + std::string(key) +
                   " must be greater than zero");
  }
  return value;
}

/** Parses, converting nlohmann's exception into the core's GraphError. */
inline Json parseJson(const std::string& text, const std::string& context) {
  try {
    return Json::parse(text);
  } catch (const nlohmann::json::exception& error) {
    failValidation(context + " is not valid JSON: " + error.what());
  }
}

}  // namespace internal
}  // namespace braindump

#endif  // BRAINDUMP_SRC_JSON_UTIL_HPP
