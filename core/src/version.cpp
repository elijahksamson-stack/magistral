// Compiled core version — reported by the addon for diagnostics.

#include <braindump/braindump.hpp>

namespace braindump {
namespace {
constexpr const char* kCoreVersion = "0.1.0";
}  // namespace

const char* version() { return kCoreVersion; }

}  // namespace braindump
