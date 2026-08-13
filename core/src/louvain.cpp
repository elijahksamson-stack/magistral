// Louvain community detection: local modularity moving, then aggregation,
// repeated until modularity stops improving.

#include "louvain.hpp"

#include <map>
#include <numeric>
#include <utility>

namespace braindump {
namespace internal {
namespace {

/** Guards against a pathological graph never reaching a fixed point. */
constexpr int kMaxLocalPasses = 32;
constexpr int kMaxLevels = 16;
/** A move must beat staying put by more than floating-point noise. */
constexpr double kMinModularityGain = 1e-12;

struct Link {
  std::size_t to = 0;
  double weight = 0.0;
};

struct LevelGraph {
  std::vector<std::vector<Link>> adjacency;
  std::vector<double> degree;
  double totalDegree = 0.0;
};

LevelGraph buildLevel(std::size_t nodeCount, const std::vector<CommunityEdge>& edges) {
  LevelGraph level;
  level.adjacency.assign(nodeCount, {});
  level.degree.assign(nodeCount, 0.0);
  for (const CommunityEdge& edge : edges) {
    if (edge.source == edge.target) {
      level.adjacency[edge.source].push_back(Link{edge.target, edge.weight});
      level.degree[edge.source] += 2.0 * edge.weight;
    } else {
      level.adjacency[edge.source].push_back(Link{edge.target, edge.weight});
      level.adjacency[edge.target].push_back(Link{edge.source, edge.weight});
      level.degree[edge.source] += edge.weight;
      level.degree[edge.target] += edge.weight;
    }
    level.totalDegree += 2.0 * edge.weight;
  }
  return level;
}

/** One full local-moving phase. `improved` reports whether anything moved. */
std::vector<std::size_t> moveNodes(const LevelGraph& level, bool& improved) {
  const std::size_t nodeCount = level.adjacency.size();
  std::vector<std::size_t> community(nodeCount);
  std::iota(community.begin(), community.end(), std::size_t{0});
  improved = false;
  if (level.totalDegree <= 0.0) {
    return community;
  }

  std::vector<double> communityDegree = level.degree;
  for (int pass = 0; pass < kMaxLocalPasses; ++pass) {
    bool hasMoved = false;
    for (std::size_t i = 0; i < nodeCount; ++i) {
      // Ordered map keeps candidate evaluation (and therefore ties) stable.
      std::map<std::size_t, double> weightToCommunity;
      for (const Link& link : level.adjacency[i]) {
        if (link.to != i) {
          weightToCommunity[community[link.to]] += link.weight;
        }
      }

      const std::size_t origin = community[i];
      communityDegree[origin] -= level.degree[i];

      const auto originWeight = weightToCommunity.find(origin);
      double bestGain =
          (originWeight == weightToCommunity.end() ? 0.0 : originWeight->second) -
          communityDegree[origin] * level.degree[i] / level.totalDegree;
      std::size_t bestCommunity = origin;

      for (const auto& candidate : weightToCommunity) {
        if (candidate.first == origin) {
          continue;
        }
        const double gain =
            candidate.second -
            communityDegree[candidate.first] * level.degree[i] / level.totalDegree;
        if (gain > bestGain + kMinModularityGain) {
          bestGain = gain;
          bestCommunity = candidate.first;
        }
      }

      communityDegree[bestCommunity] += level.degree[i];
      if (bestCommunity != origin) {
        community[i] = bestCommunity;
        hasMoved = true;
        improved = true;
      }
    }
    if (!hasMoved) {
      break;
    }
  }
  return community;
}

/** Renumber to 0..k-1 in order of first appearance. */
std::vector<std::size_t> compact(const std::vector<std::size_t>& community,
                                 std::size_t& distinctCount) {
  std::map<std::size_t, std::size_t> seen;
  std::vector<std::size_t> compacted(community.size(), 0);
  for (std::size_t i = 0; i < community.size(); ++i) {
    const auto inserted = seen.emplace(community[i], seen.size());
    compacted[i] = inserted.first->second;
  }
  distinctCount = seen.size();
  return compacted;
}

std::vector<CommunityEdge> aggregate(const std::vector<CommunityEdge>& edges,
                                     const std::vector<std::size_t>& community) {
  std::map<std::pair<std::size_t, std::size_t>, double> merged;
  for (const CommunityEdge& edge : edges) {
    std::size_t source = community[edge.source];
    std::size_t target = community[edge.target];
    if (source > target) {
      std::swap(source, target);
    }
    merged[{source, target}] += edge.weight;
  }

  std::vector<CommunityEdge> result;
  result.reserve(merged.size());
  for (const auto& entry : merged) {
    result.push_back(
        CommunityEdge{entry.first.first, entry.first.second, entry.second});
  }
  return result;
}

}  // namespace

std::vector<int> detectCommunities(std::size_t nodeCount,
                                   const std::vector<CommunityEdge>& edges) {
  std::vector<std::size_t> membership(nodeCount);
  std::iota(membership.begin(), membership.end(), std::size_t{0});
  if (nodeCount == 0) {
    return {};
  }

  std::vector<CommunityEdge> levelEdges = edges;
  std::size_t levelNodeCount = nodeCount;
  for (int level = 0; level < kMaxLevels; ++level) {
    bool improved = false;
    const std::vector<std::size_t> community =
        moveNodes(buildLevel(levelNodeCount, levelEdges), improved);
    if (!improved) {
      break;
    }

    std::size_t distinctCount = 0;
    const std::vector<std::size_t> compacted = compact(community, distinctCount);
    for (std::size_t i = 0; i < nodeCount; ++i) {
      membership[i] = compacted[membership[i]];
    }
    if (distinctCount == levelNodeCount) {
      break;  // no further coarsening possible
    }
    levelEdges = aggregate(levelEdges, compacted);
    levelNodeCount = distinctCount;
  }

  std::size_t finalCount = 0;
  const std::vector<std::size_t> finalCommunity = compact(membership, finalCount);
  std::vector<int> clusters(nodeCount, 0);
  for (std::size_t i = 0; i < nodeCount; ++i) {
    clusters[i] = static_cast<int>(finalCommunity[i]);
  }
  return clusters;
}

}  // namespace internal
}  // namespace braindump
