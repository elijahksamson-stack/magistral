# BrainDump native addon — node-gyp build.
#
# Lives at the repo root so `node-gyp rebuild` and package.json's
# "gypfile": true both find it. Output: build/Release/braindump.node
#
# The core sources are globbed rather than listed so that core/src/ can grow
# without touching this file. The glob deliberately survives an empty/absent
# core/src (the link step then reports the missing symbols, which is the
# signal we want, rather than a confusing configure-time crash).
#
# NOTE: the glob command uses `function (f) {...}` instead of an arrow
# function on purpose — gyp treats `>(` as a late-expansion variable, so `f=>f`
# would be mis-parsed.
{
  "targets": [
    {
      "target_name": "braindump",
      "sources": [
        "<!@(node -p \"const fs = require('fs'); const d = 'core/src'; fs.existsSync(d) ? fs.readdirSync(d).filter(function (f) { return f.slice(-4) === '.cpp'; }).sort().map(function (f) { return d + '/' + f; }).join(' ') : ''\")",
        "bindings/napi/addon.cpp",
        "bindings/napi/conversions.cpp",
        "bindings/napi/graph_wrap.cpp"
      ],
      "include_dirs": [
        "core/include",
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NAPI_CPP_EXCEPTIONS"
      ],
      "cflags": ["-fexceptions"],
      "cflags_cc": ["-std=c++17", "-fexceptions", "-frtti"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_CXX_LIBRARY": "libc++",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "GCC_ENABLE_CPP_RTTI": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "13.5",
        "OTHER_CFLAGS": ["-fexceptions"]
      },
      # MSVC reads none of the settings above: "cflags" is GCC/clang and
      # "xcode_settings" is macOS. Without this block a Windows build gets
      # MSBuild's defaults — C++14, no exception handling — while
      # NAPI_CPP_EXCEPTIONS above tells node-addon-api to throw. That
      # combination does not compile, and where it does it yields an addon
      # whose error paths are undefined.
      #
      # /utf-8 is not cosmetic: ten files under core/src carry em dashes in
      # their comments, and MSVC without it reads the source in the system
      # codepage and rejects them.
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "RuntimeTypeInfo": "true",
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      }
    }
  ]
}
