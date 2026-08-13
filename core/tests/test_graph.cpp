// Topology: dedup on insert, weight-merging edges, cascading removal.

#include "doctest.h"

#include <braindump/braindump.hpp>
#include <nlohmann/json.hpp>

using braindump::Graph;
using braindump::GraphError;
using braindump::NodeKind;
using braindump::RelationKind;

namespace {

nlohmann::json edgeById(const Graph& graph, const std::string& edgeId) {
  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  for (const nlohmann::json& edge : document.at("edges")) {
    if (edge.at("id") == edgeId) {
      return edge;
    }
  }
  return nlohmann::json::object();
}

}  // namespace

TEST_CASE("addNode dedups differently-cased labels onto one node") {
  Graph graph("dedup");
  const std::string first = graph.addNode("Binding Constraint", NodeKind::Concept);
  const std::string second = graph.addNode("binding   constraint", NodeKind::Entity);
  const std::string third = graph.addNode("  Binding Constraint!  ", NodeKind::Claim);

  CHECK(first == second);
  CHECK(first == third);
  CHECK(graph.nodeCount() == 1);

  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  // The label the author typed first wins; the dedup key is the normalized form.
  CHECK(document.at("nodes")[0].at("label") == "Binding Constraint");
  CHECK(document.at("nodes")[0].at("normalizedLabel") == "binding constraint");
  CHECK(document.at("nodes")[0].at("kind") == "concept");
}

TEST_CASE("addNode rejects a label with no normalizable content") {
  Graph graph("empty labels");
  CHECK_THROWS_AS(graph.addNode("", NodeKind::Concept), GraphError);
  CHECK_THROWS_AS(graph.addNode("   \t ", NodeKind::Concept), GraphError);
  CHECK(graph.nodeCount() == 0);
}

TEST_CASE("topologyVersion increments on every structural change") {
  Graph graph("versions");
  const std::uint64_t start = graph.topologyVersion();
  const std::string a = graph.addNode("A", NodeKind::Concept);
  CHECK(graph.topologyVersion() > start);

  const std::uint64_t afterNode = graph.topologyVersion();
  graph.addNode("A", NodeKind::Concept);  // dedup hit: nothing changed
  CHECK(graph.topologyVersion() == afterNode);

  const std::string b = graph.addNode("B", NodeKind::Concept);
  graph.addEdge(a, b, RelationKind::Supports);
  CHECK(graph.topologyVersion() > afterNode);
}

TEST_CASE("addEdge twice increments weight instead of duplicating") {
  Graph graph("edge merge");
  const std::string a = graph.addNode("Alpha", NodeKind::Concept);
  const std::string b = graph.addNode("Beta", NodeKind::Concept);

  const std::string first = graph.addEdge(a, b, RelationKind::Supports);
  const std::string second = graph.addEdge(a, b, RelationKind::Supports);
  CHECK(first == second);
  CHECK(graph.edgeCount() == 1);
  CHECK(edgeById(graph, first).at("weight").get<double>() == doctest::Approx(2.0));

  graph.addEdge(a, b, RelationKind::Supports, 3.0);
  CHECK(graph.edgeCount() == 1);
  CHECK(edgeById(graph, first).at("weight").get<double>() == doctest::Approx(5.0));

  // A different relation between the same pair is a different edge.
  const std::string other = graph.addEdge(a, b, RelationKind::Contradicts);
  CHECK(other != first);
  CHECK(graph.edgeCount() == 2);
}

TEST_CASE("an undirected relates_to edge dedups regardless of argument order") {
  Graph graph("undirected");
  const std::string a = graph.addNode("Alpha", NodeKind::Concept);
  const std::string b = graph.addNode("Beta", NodeKind::Concept);

  const std::string forward = graph.addEdge(a, b, RelationKind::RelatesTo);
  const std::string backward = graph.addEdge(b, a, RelationKind::RelatesTo);
  CHECK(forward == backward);
  CHECK(graph.edgeCount() == 1);
  CHECK(edgeById(graph, forward).at("directed") == false);

  const std::string causes = graph.addEdge(a, b, RelationKind::Causes);
  CHECK(edgeById(graph, causes).at("directed") == true);
}

TEST_CASE("addEdge validates its endpoints and weight") {
  Graph graph("edge validation");
  const std::string a = graph.addNode("Alpha", NodeKind::Concept);
  CHECK_THROWS_AS(graph.addEdge(a, "n999", RelationKind::Supports), GraphError);
  CHECK_THROWS_AS(graph.addEdge("n999", a, RelationKind::Supports), GraphError);

  const std::string b = graph.addNode("Beta", NodeKind::Concept);
  CHECK_THROWS_AS(graph.addEdge(a, b, RelationKind::Supports, 0.0), GraphError);
  CHECK_THROWS_AS(graph.addEdge(a, b, RelationKind::Supports, -1.0), GraphError);
  CHECK(graph.edgeCount() == 0);
}

TEST_CASE("removeNode cascades to every incident edge") {
  Graph graph("cascade");
  const std::string a = graph.addNode("Alpha", NodeKind::Concept);
  const std::string b = graph.addNode("Beta", NodeKind::Concept);
  const std::string c = graph.addNode("Gamma", NodeKind::Concept);
  graph.addEdge(a, b, RelationKind::Supports);
  graph.addEdge(b, c, RelationKind::Causes);
  graph.addEdge(a, c, RelationKind::RelatesTo);
  CHECK(graph.edgeCount() == 3);

  CHECK(graph.removeNode(b));
  CHECK(graph.nodeCount() == 2);
  CHECK(graph.edgeCount() == 1);
  CHECK_FALSE(graph.hasNode(b));
  CHECK(graph.hasNode(a));
  CHECK(graph.hasNode(c));

  CHECK_FALSE(graph.removeNode(b));
  CHECK_FALSE(graph.removeNode("n999"));
}

TEST_CASE("removing a node frees its label for reuse") {
  Graph graph("reuse");
  const std::string first = graph.addNode("Alpha", NodeKind::Concept);
  CHECK(graph.removeNode(first));
  const std::string second = graph.addNode("alpha", NodeKind::Concept);
  CHECK(second != first);
  CHECK(graph.nodeCount() == 1);
}

TEST_CASE("removeEdge drops exactly one edge") {
  Graph graph("edge removal");
  const std::string a = graph.addNode("Alpha", NodeKind::Concept);
  const std::string b = graph.addNode("Beta", NodeKind::Concept);
  const std::string edge = graph.addEdge(a, b, RelationKind::Supports);

  CHECK(graph.removeEdge(edge));
  CHECK(graph.edgeCount() == 0);
  CHECK_FALSE(graph.removeEdge(edge));

  // The triple is free again, so re-asserting creates rather than merges.
  const std::string reAsserted = graph.addEdge(a, b, RelationKind::Supports);
  CHECK(reAsserted != edge);
  CHECK(edgeById(graph, reAsserted).at("weight").get<double>() ==
        doctest::Approx(1.0));
}

TEST_CASE("nodeOrder is aligned with the layout position buffer") {
  Graph graph("order");
  graph.addNode("Alpha", NodeKind::Concept);
  graph.addNode("Beta", NodeKind::Concept);
  graph.addNode("Gamma", NodeKind::Concept);

  const std::vector<std::string> order = graph.nodeOrder();
  CHECK(order.size() == graph.nodeCount());
  CHECK(graph.layoutTick(1).positions.size() == graph.nodeCount() * 2);
}

TEST_CASE("a graph is movable and keeps its contents") {
  Graph source("movable");
  const std::string a = source.addNode("Alpha", NodeKind::Concept);
  Graph moved = std::move(source);
  CHECK(moved.nodeCount() == 1);
  CHECK(moved.hasNode(a));
  CHECK(moved.name() == "movable");
}

TEST_CASE("a graph must be named") {
  CHECK_THROWS_AS([] { Graph unnamed(""); }(), GraphError);
  Graph graph("named");
  CHECK_THROWS_AS(graph.setName(""), GraphError);
  graph.setName("renamed");
  CHECK(graph.name() == "renamed");
}

TEST_CASE("layoutConfigure rejects parameters outside the schema range") {
  Graph graph("params");
  braindump::LayoutParams params;
  params.damping = 1.5;
  CHECK_THROWS_AS(graph.layoutConfigure(params), GraphError);

  params = braindump::LayoutParams{};
  params.linkDistance = 0.0;
  CHECK_THROWS_AS(graph.layoutConfigure(params), GraphError);

  params = braindump::LayoutParams{};
  params.theta = -1.0;
  CHECK_THROWS_AS(graph.layoutConfigure(params), GraphError);

  params = braindump::LayoutParams{};
  params.linkDistance = 200.0;
  graph.layoutConfigure(params);
  CHECK(graph.layoutParams().linkDistance == doctest::Approx(200.0));
}
