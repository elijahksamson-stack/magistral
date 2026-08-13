// Canonical JSON round-trips, schema rejection, and mergeExtraction.

#include "doctest.h"

#include <braindump/braindump.hpp>
#include <nlohmann/json.hpp>

#include <string>

using braindump::Graph;
using braindump::GraphError;
using braindump::MergeReport;
using braindump::NodeKind;
using braindump::RelationKind;

namespace {

const char* const kHandwrittenGraph = R"({
  "schemaVersion": 1,
  "id": "gdeadbeefdeadbeef",
  "name": "Handwritten",
  "createdAt": "2026-08-06T09:00:00.000Z",
  "updatedAt": "2026-08-06T09:30:00.000Z",
  "cells": [
    {
      "id": "c2",
      "order": 1,
      "markdown": "Second cell mentions [[Beta]].",
      "createdAt": "2026-08-06T09:10:00.000Z",
      "updatedAt": "2026-08-06T09:20:00.000Z"
    },
    {
      "id": "c1",
      "order": 0,
      "markdown": "First cell mentions [[Alpha]].",
      "claudeSessionId": "session-abc",
      "createdAt": "2026-08-06T09:00:00.000Z",
      "updatedAt": "2026-08-06T09:05:00.000Z"
    }
  ],
  "nodes": [
    {
      "id": "n2",
      "label": "Beta",
      "normalizedLabel": "beta",
      "kind": "entity",
      "cellIds": ["c2"],
      "x": -12.5,
      "y": 7.25,
      "pinned": true,
      "degree": 1,
      "centrality": 0.5,
      "cluster": 1,
      "note": "a note"
    },
    {
      "id": "n1",
      "label": "Alpha",
      "normalizedLabel": "alpha",
      "kind": "concept",
      "cellIds": ["c1"],
      "x": 0.0,
      "y": 0.0,
      "pinned": false,
      "degree": 1,
      "centrality": 1.0,
      "cluster": 0,
      "color": "#8ab4f8"
    }
  ],
  "edges": [
    {
      "id": "e1",
      "source": "n1",
      "target": "n2",
      "relation": "supports",
      "weight": 2.5,
      "directed": true
    }
  ],
  "view": {
    "zoom": 1.25,
    "panX": -40.0,
    "panY": 12.0,
    "layout": {
      "kind": "force",
      "params": {
        "repulsion": 6000.0,
        "attraction": 0.05,
        "gravity": 0.02,
        "damping": 0.85,
        "theta": 0.5,
        "linkDistance": 120.0
      }
    }
  }
})";

/** The handwritten document with one property replaced by `patch`. */
std::string mutatedGraph(const std::string& pointer, const nlohmann::json& patch) {
  nlohmann::json document = nlohmann::json::parse(kHandwrittenGraph);
  document[nlohmann::json::json_pointer(pointer)] = patch;
  return document.dump();
}

Graph buildAuthoredGraph() {
  Graph graph("Authored");
  graph.syncCell("c1", "The [[Binding Constraint]] limits [[Capital Allocation]].");
  graph.syncCell("c2", "[[Capital Allocation]] depends on [[Free Cash Flow]].");
  const std::string constraint = graph.addNode("Binding Constraint", NodeKind::Concept);
  const std::string cash = graph.addNode("Free Cash Flow", NodeKind::Metric);
  graph.addEdge(constraint, cash, RelationKind::DependsOn, 2.0);
  graph.pinNode(constraint, 10.0, -20.0);
  graph.computeMetrics();
  graph.layoutTick(3);
  return graph;
}

}  // namespace

TEST_CASE("an authored graph round-trips byte-identically") {
  Graph graph = buildAuthoredGraph();
  const std::string first = graph.toJSON();
  const Graph reloaded = Graph::fromJSON(first);
  const std::string second = reloaded.toJSON();
  CHECK(first == second);

  const std::string third = Graph::fromJSON(second).toJSON();
  CHECK(second == third);
}

TEST_CASE("the pretty form round-trips too and differs only in whitespace") {
  Graph graph = buildAuthoredGraph();
  const std::string pretty = graph.toJSON(true);
  CHECK(pretty.find('\n') != std::string::npos);

  const Graph reloaded = Graph::fromJSON(pretty);
  CHECK(reloaded.toJSON(true) == pretty);
  CHECK(reloaded.toJSON() == graph.toJSON());
}

TEST_CASE("a handwritten document round-trips and keeps optional fields") {
  const Graph graph = Graph::fromJSON(kHandwrittenGraph);
  const std::string canonical = graph.toJSON();
  CHECK(Graph::fromJSON(canonical).toJSON() == canonical);

  const nlohmann::json document = nlohmann::json::parse(canonical);
  CHECK(document.at("id") == "gdeadbeefdeadbeef");
  CHECK(document.at("createdAt") == "2026-08-06T09:00:00.000Z");
  CHECK(document.at("updatedAt") == "2026-08-06T09:30:00.000Z");
  CHECK(document.at("nodes")[0].at("color") == "#8ab4f8");
  CHECK(document.at("nodes")[1].at("note") == "a note");
  CHECK(document.at("nodes")[1].at("pinned") == true);
  CHECK(document.at("cells")[0].at("claudeSessionId") == "session-abc");
  CHECK(document.at("view").at("zoom").get<double>() == doctest::Approx(1.25));
}

TEST_CASE("canonical output sorts arrays by id and fixes key order") {
  const std::string canonical = Graph::fromJSON(kHandwrittenGraph).toJSON();
  const nlohmann::json document = nlohmann::json::parse(canonical);
  CHECK(document.at("cells")[0].at("id") == "c1");
  CHECK(document.at("cells")[1].at("id") == "c2");
  CHECK(document.at("nodes")[0].at("id") == "n1");
  CHECK(document.at("nodes")[1].at("id") == "n2");

  CHECK(canonical.rfind("{\"schemaVersion\":1,\"id\":", 0) == 0);
  CHECK(canonical.find("\"id\"") < canonical.find("\"name\""));
  CHECK(canonical.find("\"cells\"") < canonical.find("\"nodes\""));
  CHECK(canonical.find("\"nodes\"") < canonical.find("\"edges\""));
  CHECK(canonical.find("\"edges\"") < canonical.find("\"view\""));
}

TEST_CASE("fromJSON rejects a schema version it does not speak") {
  CHECK_THROWS_AS(Graph::fromJSON(mutatedGraph("/schemaVersion", 2)), GraphError);
  CHECK_THROWS_AS(Graph::fromJSON(mutatedGraph("/schemaVersion", 0)), GraphError);
}

TEST_CASE("fromJSON rejects malformed input") {
  CHECK_THROWS_AS(Graph::fromJSON(""), GraphError);
  CHECK_THROWS_AS(Graph::fromJSON("{"), GraphError);
  CHECK_THROWS_AS(Graph::fromJSON("[]"), GraphError);
  CHECK_THROWS_AS(Graph::fromJSON("\"a string\""), GraphError);
}

TEST_CASE("fromJSON rejects structural violations of the schema") {
  SUBCASE("unknown top-level property") {
    CHECK_THROWS_AS(Graph::fromJSON(mutatedGraph("/surprise", "x")), GraphError);
  }
  SUBCASE("unknown node property") {
    CHECK_THROWS_AS(Graph::fromJSON(mutatedGraph("/nodes/0/surprise", "x")),
                    GraphError);
  }
  SUBCASE("empty name") {
    CHECK_THROWS_AS(Graph::fromJSON(mutatedGraph("/name", "")), GraphError);
  }
  SUBCASE("unknown node kind") {
    CHECK_THROWS_AS(Graph::fromJSON(mutatedGraph("/nodes/0/kind", "vibe")),
                    GraphError);
  }
  SUBCASE("unknown relation kind") {
    CHECK_THROWS_AS(Graph::fromJSON(mutatedGraph("/edges/0/relation", "vibe")),
                    GraphError);
  }
  SUBCASE("non-positive edge weight") {
    CHECK_THROWS_AS(Graph::fromJSON(mutatedGraph("/edges/0/weight", 0)), GraphError);
  }
  SUBCASE("edge pointing at a missing node") {
    CHECK_THROWS_AS(Graph::fromJSON(mutatedGraph("/edges/0/target", "n404")),
                    GraphError);
  }
  SUBCASE("duplicate node id") {
    CHECK_THROWS_AS(Graph::fromJSON(mutatedGraph("/nodes/0/id", "n1")), GraphError);
  }
  SUBCASE("centrality outside 0..1") {
    CHECK_THROWS_AS(Graph::fromJSON(mutatedGraph("/nodes/0/centrality", 1.5)),
                    GraphError);
  }
  SUBCASE("wrong type") {
    CHECK_THROWS_AS(Graph::fromJSON(mutatedGraph("/nodes", "not an array")),
                    GraphError);
  }
  SUBCASE("damping outside 0..1") {
    CHECK_THROWS_AS(
        Graph::fromJSON(mutatedGraph("/view/layout/params/damping", 2.0)),
        GraphError);
  }
}

TEST_CASE("a loaded graph keeps issuing fresh ids") {
  Graph graph = Graph::fromJSON(kHandwrittenGraph);
  const std::string fresh = graph.addNode("Gamma", NodeKind::Concept);
  CHECK(fresh != "n1");
  CHECK(fresh != "n2");
  CHECK(graph.nodeCount() == 3);
}

TEST_CASE("a loaded graph still dedups by normalized label") {
  Graph graph = Graph::fromJSON(kHandwrittenGraph);
  CHECK(graph.addNode("  ALPHA!  ", NodeKind::Concept) == "n1");
  CHECK(graph.nodeCount() == 2);
}

TEST_CASE("mergeExtraction adds nodes and edges from labels") {
  Graph graph("extraction");
  const char* const payload = R"({
    "nodes": [
      {"label": "Binding Constraint", "kind": "concept", "note": "the bottleneck"},
      {"label": "Capital Allocation", "kind": "concept"}
    ],
    "edges": [
      {"source": "Binding Constraint", "target": "Capital Allocation",
       "relation": "depends_on", "weight": 2.0}
    ]
  })";

  const MergeReport report = graph.mergeExtraction("c1", payload);
  CHECK(report.nodesAdded == 2);
  CHECK(report.nodesMerged == 0);
  CHECK(report.edgesAdded == 1);
  CHECK(report.edgesMerged == 0);
  CHECK(report.affectedNodeIds.size() == 2);
  CHECK(graph.nodeCount() == 2);
  CHECK(graph.edgeCount() == 1);

  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  CHECK(document.at("nodes")[0].at("note") == "the bottleneck");
  CHECK(document.at("nodes")[0].at("cellIds")[0] == "c1");
  CHECK(document.at("edges")[0].at("weight").get<double>() == doctest::Approx(2.0));
}

TEST_CASE("mergeExtraction is idempotent for the same cell") {
  Graph graph("extraction idempotency");
  const char* const payload = R"({
    "nodes": [
      {"label": "Alpha", "kind": "concept"},
      {"label": "Beta", "kind": "claim"}
    ],
    "edges": [{"source": "Alpha", "target": "Beta", "relation": "supports"}]
  })";

  graph.mergeExtraction("c1", payload);
  const nlohmann::json first = nlohmann::json::parse(graph.toJSON());

  const MergeReport second = graph.mergeExtraction("c1", payload);
  CHECK(second.nodesAdded == 0);
  CHECK(second.nodesMerged == 2);
  CHECK(second.edgesAdded == 0);
  CHECK(second.edgesMerged == 1);

  const nlohmann::json after = nlohmann::json::parse(graph.toJSON());
  CHECK(first.at("nodes") == after.at("nodes"));
  CHECK(first.at("edges") == after.at("edges"));
}

TEST_CASE("mergeExtraction resolves labels through normalizeLabel") {
  Graph graph("extraction dedup");
  graph.addNode("Binding Constraint", NodeKind::Concept);

  const MergeReport report = graph.mergeExtraction("c1", R"({
    "nodes": [{"label": "  binding   constraint! ", "kind": "claim"}],
    "edges": []
  })");
  CHECK(report.nodesAdded == 0);
  CHECK(report.nodesMerged == 1);
  CHECK(graph.nodeCount() == 1);
}

TEST_CASE("a second cell asserting the same edge strengthens it") {
  Graph graph("extraction weights");
  const char* const payload = R"({
    "nodes": [
      {"label": "Alpha", "kind": "concept"},
      {"label": "Beta", "kind": "concept"}
    ],
    "edges": [{"source": "Alpha", "target": "Beta", "relation": "supports"}]
  })";

  graph.mergeExtraction("c1", payload);
  const MergeReport second = graph.mergeExtraction("c2", payload);
  CHECK(second.edgesAdded == 0);
  CHECK(second.edgesMerged == 1);
  CHECK(graph.edgeCount() == 1);

  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  CHECK(document.at("edges")[0].at("weight").get<double>() == doctest::Approx(2.0));
}

TEST_CASE("mergeExtraction edges may reference nodes already in the graph") {
  Graph graph("extraction existing");
  graph.syncCell("c1", "[[Alpha]]");

  const MergeReport report = graph.mergeExtraction("c1", R"({
    "nodes": [{"label": "Beta", "kind": "concept"}],
    "edges": [{"source": "Alpha", "target": "Beta", "relation": "causes"}]
  })");
  CHECK(report.nodesAdded == 1);
  CHECK(report.edgesAdded == 1);
  CHECK(graph.edgeCount() == 1);
}

TEST_CASE("an extraction link survives the author deleting the wikilink") {
  Graph graph("extraction survives");
  graph.syncCell("c1", "[[Alpha]]");
  graph.mergeExtraction("c1", R"({
    "nodes": [{"label": "Beta", "kind": "concept"}],
    "edges": []
  })");
  graph.syncCell("c1", "no links now");

  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  for (const nlohmann::json& node : document.at("nodes")) {
    if (node.at("label") == "Beta") {
      CHECK(node.at("cellIds").size() == 1);
    }
    if (node.at("label") == "Alpha") {
      CHECK(node.at("cellIds").empty());
    }
  }
}

TEST_CASE("mergeExtraction rejects an invalid payload and changes nothing") {
  Graph graph("extraction rejection");
  graph.addNode("Existing", NodeKind::Concept);
  const std::string before = graph.toJSON();

  const auto rejects = [&graph](const char* payload) {
    CHECK_THROWS_AS(graph.mergeExtraction("c1", payload), GraphError);
  };

  rejects("not json at all");
  rejects("[]");
  rejects(R"({"nodes": []})");
  rejects(R"({"edges": []})");
  rejects(R"({"nodes": [], "edges": [], "extra": 1})");
  rejects(R"({"nodes": "no", "edges": []})");
  rejects(R"({"nodes": [{"label": "A"}], "edges": []})");
  rejects(R"({"nodes": [{"label": "", "kind": "concept"}], "edges": []})");
  rejects(R"({"nodes": [{"label": "A", "kind": "vibe"}], "edges": []})");
  rejects(R"({"nodes": [{"label": "A", "kind": "concept", "x": 1}], "edges": []})");
  rejects(R"({"nodes": [{"label": "A", "kind": "concept"}],
              "edges": [{"source": "A", "target": "Missing", "relation": "causes"}]})");
  rejects(R"({"nodes": [{"label": "A", "kind": "concept"}],
              "edges": [{"source": "A", "target": "A", "relation": "nonsense"}]})");
  rejects(R"({"nodes": [{"label": "A", "kind": "concept"}],
              "edges": [{"source": "A", "target": "A", "relation": "causes",
                         "weight": 0}]})");

  CHECK(graph.toJSON() == before);
}

TEST_CASE("mergeExtraction rejects an empty cell id") {
  Graph graph("extraction cell id");
  CHECK_THROWS_AS(graph.mergeExtraction("", R"({"nodes": [], "edges": []})"),
                  GraphError);
}

TEST_CASE("a relationship carries the author's description of it") {
  Graph graph("edge notes");
  const std::string a = graph.addNode("EUV", NodeKind::Concept);
  const std::string b = graph.addNode("Capacity", NodeKind::Concept);
  const std::string edge = graph.addEdge(a, b, RelationKind::Affects);

  graph.setEdgeNote(edge, "Scanner shipments cap how fast capacity can be added.");

  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  CHECK(document.at("edges")[0].at("relation") == "affects");
  CHECK(document.at("edges")[0].at("note") ==
        "Scanner shipments cap how fast capacity can be added.");

  // A relation kind says "affects"; only prose says how. It must survive.
  Graph reopened = Graph::fromJSON(graph.toJSON());
  CHECK(reopened.toJSON() == graph.toJSON());
}

TEST_CASE("an over-long edge note is clipped, not refused") {
  Graph graph("clipping");
  const std::string a = graph.addNode("A", NodeKind::Concept);
  const std::string b = graph.addNode("B", NodeKind::Concept);
  const std::string edge = graph.addEdge(a, b, RelationKind::AffectedBy);

  // Losing the tail is kinder than refusing the write and losing all of it.
  graph.setEdgeNote(edge, std::string(braindump::kMaxEdgeNoteLength + 500, 'x'));

  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  CHECK(document.at("edges")[0].at("note").get<std::string>().size() ==
        braindump::kMaxEdgeNoteLength);
}

TEST_CASE("an edge with no note omits the field entirely") {
  Graph graph("no note");
  const std::string a = graph.addNode("A", NodeKind::Concept);
  const std::string b = graph.addNode("B", NodeKind::Concept);
  graph.addEdge(a, b, RelationKind::Causes);

  CHECK_FALSE(nlohmann::json::parse(graph.toJSON()).at("edges")[0].contains("note"));
}

TEST_CASE("affects and affected_by are directed, unlike relates_to") {
  Graph graph("directedness");
  const std::string a = graph.addNode("A", NodeKind::Concept);
  const std::string b = graph.addNode("B", NodeKind::Concept);
  graph.addEdge(a, b, RelationKind::Affects);
  graph.addEdge(a, b, RelationKind::AffectedBy);

  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  for (const nlohmann::json& edge : document.at("edges")) {
    CHECK(edge.at("directed") == true);
  }
  // Two distinct relations between the same pair, not one deduplicated edge.
  CHECK(graph.edgeCount() == 2);
}

TEST_CASE("setEdgeNote refuses an unknown edge rather than silently doing nothing") {
  Graph graph("unknown");
  CHECK_THROWS_AS(graph.setEdgeNote("e999", "note"), GraphError);
}

// ---------------------------------------------------------------------------
// Node notes
// ---------------------------------------------------------------------------
//
// A node created directly — a group, or a concept accepted from "Complete the
// map" — has no [[wikilink]] line to take its description from. Without a
// setter, the reasoning behind an accepted proposal would be lost exactly when
// the author decided it was worth keeping.

TEST_CASE("a node note survives a round trip") {
  Graph graph("node notes");
  const std::string node = graph.addNode("Interconnect Queue", NodeKind::Concept);
  graph.setNodeNote(node, "The wait between a project being financed and it being energised.");

  Graph reopened = Graph::fromJSON(graph.toJSON());
  CHECK(reopened.toJSON() == graph.toJSON());

  const nlohmann::json document = nlohmann::json::parse(reopened.toJSON());
  CHECK(document.at("nodes")[0].at("note").get<std::string>().find("energised") !=
        std::string::npos);
}

TEST_CASE("an over-long node note is clipped, not refused") {
  Graph graph("clipping");
  const std::string node = graph.addNode("A", NodeKind::Concept);

  graph.setNodeNote(node, std::string(braindump::kMaxEdgeNoteLength + 500, 'x'));

  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  CHECK(document.at("nodes")[0].at("note").get<std::string>().size() ==
        braindump::kMaxEdgeNoteLength);
}

TEST_CASE("setNodeNote refuses an unknown node rather than silently doing nothing") {
  Graph graph("unknown");
  CHECK_THROWS_AS(graph.setNodeNote("n999", "note"), GraphError);
}

TEST_CASE("a node note is not indexed for search — only labels are") {
  // Documented because it is a reasonable thing to assume otherwise. Indexing
  // notes would change what every existing search returns, which is a decision
  // about search, not a side effect of adding a setter.
  Graph graph("searchable");
  const std::string node = graph.addNode("Heat Rate", NodeKind::Concept);
  graph.setNodeNote(node, "Turbine efficiency expressed as fuel burned per unit of output.");

  CHECK(graph.search("turbine", 10).empty());
  CHECK(graph.search("heat", 10).size() == 1);
}
