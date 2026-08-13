// The ONE translation unit that defines doctest's main.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include <braindump/braindump.hpp>

TEST_CASE("core reports its semver") {
  CHECK(std::string(braindump::version()) == "0.1.0");
  CHECK(braindump::kSchemaVersion == 1);
}
