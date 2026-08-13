// Per-environment addon state.
//
// Node can load one addon into several environments (worker threads, Electron
// utility processes). A static constructor reference would be shared across
// them and crash on teardown, so it is stored as N-API instance data instead.

#ifndef BRAINDUMP_NAPI_ADDON_DATA_HPP
#define BRAINDUMP_NAPI_ADDON_DATA_HPP

#include <napi.h>

namespace braindump_napi {

struct AddonData {
  /** The JS `Graph` class. Only createGraph()/graphFromJSON() invoke it. */
  Napi::FunctionReference graphConstructor;
};

}  // namespace braindump_napi

#endif  // BRAINDUMP_NAPI_ADDON_DATA_HPP
