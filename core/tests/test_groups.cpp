// Group nodes: containers that enclose other nodes on the canvas.

#include "doctest.h"

#include <braindump/braindump.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <unordered_map>
#include <utility>

using braindump::Graph;
using braindump::GraphError;
using braindump::NodeKind;
using braindump::RelationKind;

namespace {

std::string groupIdOf(const Graph& graph, const std::string& nodeId) {
  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  for (const nlohmann::json& node : document.at("nodes")) {
    if (node.at("id") == nodeId) {
      return node.contains("groupId") ? node.at("groupId").get<std::string>() : std::string{};
    }
  }
  return {};
}

}  // namespace

TEST_CASE("a node joins and leaves a group") {
  Graph graph("groups");
  const std::string sector = graph.addNode("Power", NodeKind::Group);
  const std::string a = graph.addNode("EUV", NodeKind::Concept);

  graph.setNodeGroup(a, sector);
  CHECK(graph.groupMembers(sector) == std::vector<std::string>{a});
  CHECK(groupIdOf(graph, a) == sector);

  graph.setNodeGroup(a, "");
  CHECK(graph.groupMembers(sector).empty());
  CHECK(groupIdOf(graph, a).empty());
}

TEST_CASE("a node belongs to at most one group") {
  Graph graph("exclusive");
  const std::string first = graph.addNode("First", NodeKind::Group);
  const std::string second = graph.addNode("Second", NodeKind::Group);
  const std::string node = graph.addNode("Member", NodeKind::Concept);

  graph.setNodeGroup(node, first);
  graph.setNodeGroup(node, second);

  // Joining the second must LEAVE the first, not sit in both.
  CHECK(graph.groupMembers(first).empty());
  CHECK(graph.groupMembers(second) == std::vector<std::string>{node});
}

TEST_CASE("grouping refuses what it cannot honestly represent") {
  Graph graph("refusals");
  const std::string group = graph.addNode("Outer", NodeKind::Group);
  const std::string inner = graph.addNode("Inner", NodeKind::Group);
  const std::string node = graph.addNode("Member", NodeKind::Concept);

  // Nesting is a different feature; accepting the write and never drawing it
  // would be worse than refusing.
  CHECK_THROWS_AS(graph.setNodeGroup(inner, group), GraphError);
  // A non-group cannot contain anything.
  CHECK_THROWS_AS(graph.setNodeGroup(node, node), GraphError);
  CHECK_THROWS_AS(graph.setNodeGroup("missing", group), GraphError);
  CHECK_THROWS_AS(graph.setNodeGroup(node, "missing"), GraphError);
}

TEST_CASE("deleting a group releases its members rather than stranding them") {
  Graph graph("release");
  const std::string group = graph.addNode("Power", NodeKind::Group);
  const std::string a = graph.addNode("EUV", NodeKind::Concept);
  const std::string b = graph.addNode("ASML", NodeKind::Concept);
  graph.setNodeGroup(a, group);
  graph.setNodeGroup(b, group);

  REQUIRE(graph.removeNode(group));

  CHECK(graph.nodeCount() == 2);
  // A groupId pointing at a node that no longer exists would be unresolvable.
  CHECK(groupIdOf(graph, a).empty());
  CHECK(groupIdOf(graph, b).empty());
}

TEST_CASE("a group survives orphan collection, having no cells to lose") {
  Graph graph("survives");
  const std::string group = graph.addNode("Power", NodeKind::Group);
  graph.syncCell("c1", "[[EUV]]");
  const std::string euv = graph.groupMembers(group).empty() ? graph.nodeOrder().back() : "";
  graph.setNodeGroup(euv, group);

  // Clearing the cell collects EUV, which was asserted by text. The group was
  // made directly by the author and must not go with it.
  graph.syncCell("c1", "");

  CHECK(graph.hasNode(group));
  CHECK(graph.nodeCount() == 1);
}

TEST_CASE("group membership round-trips through JSON") {
  Graph graph("round trip");
  const std::string group = graph.addNode("Power", NodeKind::Group);
  const std::string a = graph.addNode("EUV", NodeKind::Concept);
  graph.setNodeGroup(a, group);

  const std::string once = graph.toJSON();
  Graph reopened = Graph::fromJSON(once);

  CHECK(reopened.toJSON() == once);
  CHECK(reopened.groupMembers(group) == std::vector<std::string>{a});
}

TEST_CASE("the group kind survives a round trip") {
  Graph graph("kind");
  graph.addNode("Power", NodeKind::Group);
  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  CHECK(document.at("nodes")[0].at("kind") == "group");
}

TEST_CASE("members sit nearer their own group than another group's members") {
  // What grouping buys is SEPARATION, not compaction: a handful of free nodes
  // already cluster under plain repulsion, so asserting that a lone group is
  // tighter than no group at all measures nothing.
  Graph graph("separation");
  const std::string left = graph.addNode("Left", NodeKind::Group);
  const std::string right = graph.addNode("Right", NodeKind::Group);

  std::vector<std::string> leftMembers;
  std::vector<std::string> rightMembers;
  for (int i = 0; i < 4; ++i) {
    leftMembers.push_back(graph.addNode("L" + std::to_string(i), NodeKind::Concept));
    rightMembers.push_back(graph.addNode("R" + std::to_string(i), NodeKind::Concept));
  }
  for (const std::string& id : leftMembers) graph.setNodeGroup(id, left);
  for (const std::string& id : rightMembers) graph.setNodeGroup(id, right);

  graph.layoutReset(0);
  graph.layoutSettle(800);

  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  std::unordered_map<std::string, std::pair<double, double>> at;
  for (const nlohmann::json& node : document.at("nodes")) {
    at[node.at("id").get<std::string>()] = {node.at("x").get<double>(),
                                            node.at("y").get<double>()};
  }
  const auto distance = [&](const std::string& a, const std::string& b) {
    return std::hypot(at[a].first - at[b].first, at[a].second - at[b].second);
  };

  double withinWorst = 0.0;
  for (const std::string& a : leftMembers) {
    withinWorst = std::max(withinWorst, distance(a, left));
  }
  double acrossBest = 1e9;
  for (const std::string& a : leftMembers) {
    for (const std::string& b : rightMembers) {
      acrossBest = std::min(acrossBest, distance(a, b));
    }
  }

  CHECK(withinWorst < acrossBest);
}

TEST_CASE("two groups settle far enough apart that their circles do not overlap") {
  // A group repels as if it were the area its members occupy. Without that,
  // two groups sit on top of one another and the rings drawn around them
  // overlap into something no one can read membership from.
  Graph graph("separation of hulls");
  const std::string left = graph.addNode("Left", NodeKind::Group);
  const std::string right = graph.addNode("Right", NodeKind::Group);

  for (int i = 0; i < 4; ++i) {
    const std::string a = graph.addNode("L" + std::to_string(i), NodeKind::Concept);
    const std::string b = graph.addNode("R" + std::to_string(i), NodeKind::Concept);
    graph.setNodeGroup(a, left);
    graph.setNodeGroup(b, right);
  }

  graph.layoutReset(0);
  graph.layoutSettle(1200);

  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  std::unordered_map<std::string, std::pair<double, double>> at;
  std::unordered_map<std::string, std::string> groupOf;
  for (const nlohmann::json& node : document.at("nodes")) {
    const std::string id = node.at("id").get<std::string>();
    at[id] = {node.at("x").get<double>(), node.at("y").get<double>()};
    if (node.contains("groupId")) groupOf[id] = node.at("groupId").get<std::string>();
  }

  // Radius of each hull: furthest member from its group node.
  const auto radiusOf = [&](const std::string& groupId) {
    double radius = 0.0;
    for (const auto& [id, gid] : groupOf) {
      if (gid != groupId) continue;
      radius = std::max(radius, std::hypot(at[id].first - at[groupId].first,
                                           at[id].second - at[groupId].second));
    }
    return radius;
  };

  const double centres = std::hypot(at[left].first - at[right].first,
                                    at[left].second - at[right].second);
  CHECK(centres > radiusOf(left) + radiusOf(right));
}

TEST_CASE("a node can be renamed") {
  Graph graph("rename");
  const std::string group = graph.addNode("Powr Markts", NodeKind::Group);

  graph.setNodeLabel(group, "Power Markets");

  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  CHECK(document.at("nodes")[0].at("label") == "Power Markets");
  CHECK(document.at("nodes")[0].at("normalizedLabel") == "power markets");
}

TEST_CASE("renaming keeps the node findable under its new label") {
  Graph graph("reindex");
  const std::string id = graph.addNode("Old Name", NodeKind::Concept);
  graph.setNodeLabel(id, "New Name");

  // The normalized index is keyed by label; a stale key would leave the node
  // unsearchable and let a duplicate be created under the new name.
  CHECK(graph.addNode("new name", NodeKind::Concept) == id);
  CHECK(graph.nodeCount() == 1);
}

TEST_CASE("renaming onto another node's label is refused") {
  Graph graph("collision");
  graph.addNode("Taken", NodeKind::Concept);
  const std::string other = graph.addNode("Free", NodeKind::Concept);

  CHECK_THROWS_AS(graph.setNodeLabel(other, "taken"), GraphError);
  CHECK_THROWS_AS(graph.setNodeLabel(other, ""), GraphError);
  CHECK_THROWS_AS(graph.setNodeLabel("missing", "Anything"), GraphError);
}

TEST_CASE("re-spelling the same node is allowed") {
  Graph graph("respell");
  const std::string id = graph.addNode("power markets", NodeKind::Group);
  // Same normalized form, different display text — not a collision with itself.
  graph.setNodeLabel(id, "Power Markets");
  CHECK(nlohmann::json::parse(graph.toJSON()).at("nodes")[0].at("label") == "Power Markets");
}

TEST_CASE("renaming a group keeps its members") {
  Graph graph("keep members");
  const std::string group = graph.addNode("Old", NodeKind::Group);
  const std::string member = graph.addNode("Member", NodeKind::Concept);
  graph.setNodeGroup(member, group);

  graph.setNodeLabel(group, "New");

  CHECK(graph.groupMembers(group) == std::vector<std::string>{member});
}
