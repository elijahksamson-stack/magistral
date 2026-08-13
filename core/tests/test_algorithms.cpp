// Components, shortest paths and computeMetrics over a known fixture.

#include "doctest.h"

#include <braindump/braindump.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

using braindump::Graph;
using braindump::GraphError;
using braindump::NodeKind;
using braindump::RelationKind;

namespace {

/** Alpha-Beta-Gamma chain, a Delta-Epsilon pair, and an isolated Zeta. */
struct Fixture {
  Graph graph{"fixture"};
  std::string alpha;
  std::string beta;
  std::string gamma;
  std::string delta;
  std::string epsilon;
  std::string zeta;

  Fixture() {
    alpha = graph.addNode("Alpha", NodeKind::Concept);
    beta = graph.addNode("Beta", NodeKind::Concept);
    gamma = graph.addNode("Gamma", NodeKind::Concept);
    delta = graph.addNode("Delta", NodeKind::Entity);
    epsilon = graph.addNode("Epsilon", NodeKind::Entity);
    zeta = graph.addNode("Zeta", NodeKind::Question);
    graph.addEdge(alpha, beta, RelationKind::Supports);
    graph.addEdge(beta, gamma, RelationKind::Causes);
    graph.addEdge(delta, epsilon, RelationKind::RelatesTo);
  }
};

nlohmann::json nodeByLabel(const Graph& graph, const std::string& label) {
  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  for (const nlohmann::json& node : document.at("nodes")) {
    if (node.at("label") == label) {
      return node;
    }
  }
  return nlohmann::json::object();
}

}  // namespace

TEST_CASE("components partitions the graph") {
  Fixture fixture;
  const std::vector<std::vector<std::string>> components = fixture.graph.components();
  REQUIRE(components.size() == 3);

  std::vector<std::size_t> sizes;
  for (const std::vector<std::string>& component : components) {
    sizes.push_back(component.size());
  }
  std::sort(sizes.begin(), sizes.end());
  CHECK(sizes == std::vector<std::size_t>{1, 2, 3});

  // Each component is sorted, and the outer list is sorted too — determinism.
  for (const std::vector<std::string>& component : components) {
    CHECK(std::is_sorted(component.begin(), component.end()));
  }
  CHECK(std::is_sorted(components.begin(), components.end()));
}

TEST_CASE("components of an empty graph is empty") {
  Graph graph("nothing");
  CHECK(graph.components().empty());
}

TEST_CASE("shortestPath includes both endpoints") {
  Fixture fixture;
  const std::vector<std::string> path =
      fixture.graph.shortestPath(fixture.alpha, fixture.gamma);
  CHECK(path == std::vector<std::string>{fixture.alpha, fixture.beta, fixture.gamma});

  // Direction of the edges does not gate traversal.
  const std::vector<std::string> reverse =
      fixture.graph.shortestPath(fixture.gamma, fixture.alpha);
  CHECK(reverse ==
        std::vector<std::string>{fixture.gamma, fixture.beta, fixture.alpha});
}

TEST_CASE("shortestPath is empty when unreachable") {
  Fixture fixture;
  CHECK(fixture.graph.shortestPath(fixture.alpha, fixture.delta).empty());
  CHECK(fixture.graph.shortestPath(fixture.alpha, fixture.zeta).empty());
}

TEST_CASE("shortestPath from a node to itself is that node") {
  Fixture fixture;
  CHECK(fixture.graph.shortestPath(fixture.alpha, fixture.alpha) ==
        std::vector<std::string>{fixture.alpha});
}

TEST_CASE("shortestPath rejects unknown ids") {
  Fixture fixture;
  CHECK_THROWS_AS(fixture.graph.shortestPath(fixture.alpha, "n999"), GraphError);
  CHECK_THROWS_AS(fixture.graph.shortestPath("n999", fixture.alpha), GraphError);
}

TEST_CASE("shortestPath takes the shorter of two routes") {
  Graph graph("routes");
  const std::string a = graph.addNode("A", NodeKind::Concept);
  const std::string b = graph.addNode("B", NodeKind::Concept);
  const std::string c = graph.addNode("C", NodeKind::Concept);
  const std::string d = graph.addNode("D", NodeKind::Concept);
  graph.addEdge(a, b, RelationKind::RelatesTo);
  graph.addEdge(b, c, RelationKind::RelatesTo);
  graph.addEdge(c, d, RelationKind::RelatesTo);
  graph.addEdge(a, d, RelationKind::RelatesTo);

  CHECK(graph.shortestPath(a, d) == std::vector<std::string>{a, d});
}

TEST_CASE("computeMetrics fills degree, centrality and cluster") {
  Fixture fixture;
  fixture.graph.computeMetrics();

  CHECK(nodeByLabel(fixture.graph, "Alpha").at("degree") == 1);
  CHECK(nodeByLabel(fixture.graph, "Beta").at("degree") == 2);
  CHECK(nodeByLabel(fixture.graph, "Zeta").at("degree") == 0);

  const nlohmann::json document = nlohmann::json::parse(fixture.graph.toJSON());
  double peak = 0.0;
  for (const nlohmann::json& node : document.at("nodes")) {
    const double centrality = node.at("centrality").get<double>();
    CHECK(centrality >= 0.0);
    CHECK(centrality <= 1.0);
    peak = std::max(peak, centrality);
    CHECK(node.at("cluster").get<int>() >= 0);
  }
  CHECK(peak == doctest::Approx(1.0));

  // Beta sits between two leaves, so it must out-rank Alpha.
  CHECK(nodeByLabel(fixture.graph, "Beta").at("centrality").get<double>() >
        nodeByLabel(fixture.graph, "Alpha").at("centrality").get<double>());
}

TEST_CASE("computeMetrics puts a connected clique in one cluster") {
  Graph graph("clusters");
  std::vector<std::string> left;
  std::vector<std::string> right;
  for (int i = 0; i < 5; ++i) {
    left.push_back(graph.addNode("L" + std::to_string(i), NodeKind::Concept));
    right.push_back(graph.addNode("R" + std::to_string(i), NodeKind::Concept));
  }
  for (int i = 0; i < 5; ++i) {
    for (int j = i + 1; j < 5; ++j) {
      graph.addEdge(left[static_cast<std::size_t>(i)],
                    left[static_cast<std::size_t>(j)], RelationKind::RelatesTo);
      graph.addEdge(right[static_cast<std::size_t>(i)],
                    right[static_cast<std::size_t>(j)], RelationKind::RelatesTo);
    }
  }
  graph.addEdge(left[0], right[0], RelationKind::RelatesTo);
  graph.computeMetrics();

  const int leftCluster = nodeByLabel(graph, "L0").at("cluster").get<int>();
  const int rightCluster = nodeByLabel(graph, "R0").at("cluster").get<int>();
  CHECK(leftCluster != rightCluster);
  for (int i = 1; i < 5; ++i) {
    CHECK(nodeByLabel(graph, "L" + std::to_string(i)).at("cluster").get<int>() ==
          leftCluster);
    CHECK(nodeByLabel(graph, "R" + std::to_string(i)).at("cluster").get<int>() ==
          rightCluster);
  }
}

TEST_CASE("computeMetrics is deterministic and repeatable") {
  Fixture fixture;
  fixture.graph.computeMetrics();
  const nlohmann::json first =
      nlohmann::json::parse(fixture.graph.toJSON()).at("nodes");
  fixture.graph.computeMetrics();
  const nlohmann::json second =
      nlohmann::json::parse(fixture.graph.toJSON()).at("nodes");
  CHECK(first == second);
}

TEST_CASE("computeMetrics on an edgeless graph leaves centrality uniform") {
  Graph graph("edgeless");
  graph.addNode("A", NodeKind::Concept);
  graph.addNode("B", NodeKind::Concept);
  graph.computeMetrics();

  CHECK(nodeByLabel(graph, "A").at("degree") == 0);
  CHECK(nodeByLabel(graph, "A").at("centrality").get<double>() ==
        doctest::Approx(nodeByLabel(graph, "B").at("centrality").get<double>()));
}
