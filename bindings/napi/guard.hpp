// Exception firewall for the N-API boundary.
//
// A C++ exception that escapes into the N-API C callback aborts the whole
// process. node-addon-api's own wrapper only understands Napi::Error, so every
// call into braindump:: must pass through `guarded`, which converts anything
// else into a JS Error carrying the original message.

#ifndef BRAINDUMP_NAPI_GUARD_HPP
#define BRAINDUMP_NAPI_GUARD_HPP

#include <napi.h>

#include <exception>

#include "braindump/braindump.hpp"

namespace braindump_napi {

/**
 * Run `fn` and translate any native exception into a JS Error.
 *
 * Napi::Error is rethrown untouched so that argument-validation errors keep
 * their original JS type (TypeError / RangeError).
 */
template <typename Fn>
Napi::Value guarded(Napi::Env env, Fn&& fn) {
  try {
    return fn();
  } catch (const Napi::Error&) {
    throw;
  } catch (const braindump::GraphError& error) {
    throw Napi::Error::New(env, error.what());
  } catch (const std::exception& error) {
    throw Napi::Error::New(env, error.what());
  } catch (...) {
    throw Napi::Error::New(env, "braindump: unknown native error");
  }
}

}  // namespace braindump_napi

#endif  // BRAINDUMP_NAPI_GUARD_HPP
