// normalizeLabel — the dedup key — plus the enum wire names.

#include "doctest.h"

#include <braindump/braindump.hpp>

using braindump::NodeKind;
using braindump::RelationKind;
using braindump::normalizeLabel;

TEST_CASE("normalizeLabel lowercases ASCII") {
  CHECK(normalizeLabel("The Binding Constraint") == "the binding constraint");
  CHECK(normalizeLabel("ROIC") == "roic");
  CHECK(normalizeLabel("already lower") == "already lower");
}

TEST_CASE("normalizeLabel collapses and trims whitespace") {
  CHECK(normalizeLabel("  binding   constraint ") == "binding constraint");
  CHECK(normalizeLabel("binding\tconstraint") == "binding constraint");
  CHECK(normalizeLabel("binding\n\nconstraint") == "binding constraint");
  CHECK(normalizeLabel("\t\n  ") == "");
  CHECK(normalizeLabel("") == "");
}

TEST_CASE("normalizeLabel strips surrounding punctuation only") {
  CHECK(normalizeLabel("Binding Constraint!") == "binding constraint");
  CHECK(normalizeLabel("**Binding Constraint**") == "binding constraint");
  CHECK(normalizeLabel("  \"Free Cash Flow\", ") == "free cash flow");
  CHECK(normalizeLabel("e-commerce") == "e-commerce");
  CHECK(normalizeLabel("cost/income ratio") == "cost/income ratio");
}

TEST_CASE("normalizeLabel keeps an all-punctuation label addressable") {
  // Normalizing to "" would make every such label collide on one dedup key.
  CHECK(normalizeLabel("!!!") == "!!!");
  CHECK(normalizeLabel("  ???  ") == "???");
}

TEST_CASE("normalizeLabel passes non-ASCII bytes through untouched") {
  CHECK(normalizeLabel("Café Noir") == "café noir");
  // Case folding is ASCII-only by contract, so "Ü" survives while "BER" folds.
  CHECK(normalizeLabel("  ÜBER  ") == "Über");
  CHECK(normalizeLabel("日本語") == "日本語");
}

TEST_CASE("normalizeLabel is idempotent") {
  const std::string once = normalizeLabel("  The *Binding*  Constraint!  ");
  CHECK(normalizeLabel(once) == once);
}

TEST_CASE("node kinds round-trip through their wire names") {
  CHECK(std::string(braindump::toString(NodeKind::Concept)) == "concept");
  CHECK(std::string(braindump::toString(NodeKind::Entity)) == "entity");
  CHECK(std::string(braindump::toString(NodeKind::Claim)) == "claim");
  CHECK(std::string(braindump::toString(NodeKind::Question)) == "question");
  CHECK(std::string(braindump::toString(NodeKind::Source)) == "source");
  CHECK(std::string(braindump::toString(NodeKind::Metric)) == "metric");

  for (int i = 0; i < 6; ++i) {
    const NodeKind kind = static_cast<NodeKind>(i);
    CHECK(static_cast<int>(
              braindump::nodeKindFromString(braindump::toString(kind))) == i);
  }
  CHECK_THROWS_AS(braindump::nodeKindFromString("nonsense"), std::invalid_argument);
}

TEST_CASE("relation kinds round-trip through their wire names") {
  CHECK(std::string(braindump::toString(RelationKind::RelatesTo)) == "relates_to");
  CHECK(std::string(braindump::toString(RelationKind::DependsOn)) == "depends_on");
  CHECK(std::string(braindump::toString(RelationKind::Mentions)) == "mentions");

  for (int i = 0; i < 8; ++i) {
    const RelationKind relation = static_cast<RelationKind>(i);
    CHECK(static_cast<int>(braindump::relationKindFromString(
              braindump::toString(relation))) == i);
  }
  CHECK_THROWS_AS(braindump::relationKindFromString("nonsense"),
                  std::invalid_argument);
}
