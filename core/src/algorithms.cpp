// Graph analysis: connected components, PageRank centrality, Louvain clusters
// and BFS shortest paths. Traversal treats every edge as undirected — a
// knowledge graph is navigated in both directions regardless of arrow head.

#include "graph_impl.hpp"
#include "louvain.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <deque>
#include <vector>

namespace braindump {
namespace {

constexpr double kPageRankDamping = 0.85;
constexpr int kPageRankMaxIterations = 100;
constexpr double kPageRankTolerance = 1e-10;

struct WeightedLink {
  std::size_t to = 0;
  double weight = 1.0;
};

std::vector<std::vector<WeightedLink>> buildWeightedAdjacency(
    std::size_t nodeCount, const std::vector<internal::EdgeRecord>& edges,
    const std::unordered_map<std::string, std::size_t>& nodeById) {
  std::vector<std::vector<WeightedLink>> adjacency(nodeCount);
  for (const internal::EdgeRecord& edge : edges) {
    const auto source = nodeById.find(edge.source);
    const auto target = nodeById.find(edge.target);
    if (source == nodeById.end() || target == nodeById.end()) {
      continue;
    }
    adjacency[source->second].push_back(WeightedLink{target->second, edge.weight});
    if (source->second != target->second) {
      adjacency[target->second].push_back(WeightedLink{source->second, edge.weight});
    }
  }
  return adjacency;
}

/** PageRank over the undirected adjacency, rescaled so the maximum is 1. */
std::vector<double> pageRank(
    const std::vector<std::vector<WeightedLink>>& adjacency) {
  const std::size_t nodeCount = adjacency.size();
  if (nodeCount == 0) {
    return {};
  }

  const double uniform = 1.0 / static_cast<double>(nodeCount);
  std::vector<double> rank(nodeCount, uniform);
  std::vector<double> next(nodeCount, 0.0);
  std::vector<double> outWeight(nodeCount, 0.0);
  for (std::size_t i = 0; i < nodeCount; ++i) {
    for (const WeightedLink& link : adjacency[i]) {
      outWeight[i] += link.weight;
    }
  }

  for (int iteration = 0; iteration < kPageRankMaxIterations; ++iteration) {
    double danglingMass = 0.0;
    for (std::size_t i = 0; i < nodeCount; ++i) {
      if (outWeight[i] <= 0.0) {
        danglingMass += rank[i];
      }
    }
    const double base =
        (1.0 - kPageRankDamping) * uniform + kPageRankDamping * danglingMass * uniform;
    std::fill(next.begin(), next.end(), base);

    for (std::size_t i = 0; i < nodeCount; ++i) {
      if (outWeight[i] <= 0.0) {
        continue;
      }
      const double share = kPageRankDamping * rank[i] / outWeight[i];
      for (const WeightedLink& link : adjacency[i]) {
        next[link.to] += share * link.weight;
      }
    }

    double delta = 0.0;
    for (std::size_t i = 0; i < nodeCount; ++i) {
      delta += std::abs(next[i] - rank[i]);
    }
    rank.swap(next);
    if (delta < kPageRankTolerance) {
      break;
    }
  }

  const double peak = *std::max_element(rank.begin(), rank.end());
  if (peak > 0.0) {
    for (double& value : rank) {
      value = std::min(1.0, value / peak);
    }
  }
  return rank;
}

}  // namespace

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

std::vector<std::vector<std::size_t>> Graph::Impl::buildAdjacency() const {
  std::vector<std::vector<std::size_t>> adjacency(nodes.size());
  for (const internal::EdgeRecord& edge : edges) {
    const auto source = nodeById.find(edge.source);
    const auto target = nodeById.find(edge.target);
    if (source == nodeById.end() || target == nodeById.end() ||
        source->second == target->second) {
      continue;
    }
    adjacency[source->second].push_back(target->second);
    adjacency[target->second].push_back(source->second);
  }

  for (std::vector<std::size_t>& neighbours : adjacency) {
    // Sort by node id so traversal order never depends on insertion history.
    std::sort(neighbours.begin(), neighbours.end(),
              [this](std::size_t a, std::size_t b) {
                return nodes[a].id < nodes[b].id;
              });
    neighbours.erase(std::unique(neighbours.begin(), neighbours.end()),
                     neighbours.end());
  }
  return adjacency;
}

void Graph::Impl::computeMetrics() {
  for (internal::NodeRecord& node : nodes) {
    node.degree = 0;
    node.centrality = 0.0;
    node.cluster = 0;
  }
  if (nodes.empty()) {
    return;
  }

  for (const internal::EdgeRecord& edge : edges) {
    const auto source = nodeById.find(edge.source);
    const auto target = nodeById.find(edge.target);
    if (source != nodeById.end()) {
      ++nodes[source->second].degree;
    }
    if (target != nodeById.end()) {
      ++nodes[target->second].degree;
    }
  }

  const std::vector<std::vector<WeightedLink>> adjacency =
      buildWeightedAdjacency(nodes.size(), edges, nodeById);
  const std::vector<double> centrality = pageRank(adjacency);
  for (std::size_t i = 0; i < nodes.size(); ++i) {
    nodes[i].centrality = centrality[i];
  }

  std::vector<internal::CommunityEdge> communityEdges;
  communityEdges.reserve(edges.size());
  for (const internal::EdgeRecord& edge : edges) {
    const auto source = nodeById.find(edge.source);
    const auto target = nodeById.find(edge.target);
    if (source == nodeById.end() || target == nodeById.end()) {
      continue;
    }
    communityEdges.push_back(
        internal::CommunityEdge{source->second, target->second, edge.weight});
  }
  const std::vector<int> clusters =
      internal::detectCommunities(nodes.size(), communityEdges);
  for (std::size_t i = 0; i < nodes.size(); ++i) {
    nodes[i].cluster = clusters[i];
  }

  touchDocument();
}

std::vector<std::vector<std::string>> Graph::Impl::components() const {
  const std::vector<std::vector<std::size_t>> adjacency = buildAdjacency();
  std::vector<char> isVisited(nodes.size(), 0);
  std::vector<std::vector<std::string>> result;

  for (std::size_t start = 0; start < nodes.size(); ++start) {
    if (isVisited[start] != 0) {
      continue;
    }
    std::vector<std::string> component;
    std::deque<std::size_t> queue{start};
    isVisited[start] = 1;
    while (!queue.empty()) {
      const std::size_t current = queue.front();
      queue.pop_front();
      component.push_back(nodes[current].id);
      for (const std::size_t neighbour : adjacency[current]) {
        if (isVisited[neighbour] == 0) {
          isVisited[neighbour] = 1;
          queue.push_back(neighbour);
        }
      }
    }
    std::sort(component.begin(), component.end());
    result.push_back(std::move(component));
  }

  std::sort(result.begin(), result.end());
  return result;
}

std::vector<std::string> Graph::Impl::shortestPath(const std::string& fromId,
                                                   const std::string& toId) const {
  const std::size_t from = requireNodeIndex(fromId);
  const std::size_t to = requireNodeIndex(toId);
  if (from == to) {
    return {nodes[from].id};
  }

  const std::vector<std::vector<std::size_t>> adjacency = buildAdjacency();
  constexpr std::size_t kNoParent = static_cast<std::size_t>(-1);
  std::vector<std::size_t> parent(nodes.size(), kNoParent);
  std::vector<char> isVisited(nodes.size(), 0);
  std::deque<std::size_t> queue{from};
  isVisited[from] = 1;

  bool isFound = false;
  while (!queue.empty() && !isFound) {
    const std::size_t current = queue.front();
    queue.pop_front();
    for (const std::size_t neighbour : adjacency[current]) {
      if (isVisited[neighbour] != 0) {
        continue;
      }
      isVisited[neighbour] = 1;
      parent[neighbour] = current;
      if (neighbour == to) {
        isFound = true;
        break;
      }
      queue.push_back(neighbour);
    }
  }
  if (!isFound) {
    return {};
  }

  std::vector<std::string> path;
  for (std::size_t at = to; at != kNoParent; at = parent[at]) {
    path.push_back(nodes[at].id);
    if (at == from) {
      break;
    }
  }
  std::reverse(path.begin(), path.end());
  return path;
}

// ---------------------------------------------------------------------------
// Graph — public surface
// ---------------------------------------------------------------------------

void Graph::computeMetrics() { impl_->computeMetrics(); }

std::vector<std::vector<std::string>> Graph::components() const {
  return impl_->components();
}

std::vector<std::string> Graph::shortestPath(const std::string& fromId,
                                             const std::string& toId) const {
  return impl_->shortestPath(fromId, toId);
}

}  // namespace braindump
