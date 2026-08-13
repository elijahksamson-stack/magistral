// PRIVATE. Louvain modularity community detection over an undirected,
// weighted graph expressed as node indices.

#ifndef BRAINDUMP_SRC_LOUVAIN_HPP
#define BRAINDUMP_SRC_LOUVAIN_HPP

#include <cstddef>
#include <vector>

namespace braindump {
namespace internal {

/** One undirected weighted link. source == target expresses a self-loop. */
struct CommunityEdge {
  std::size_t source = 0;
  std::size_t target = 0;
  double weight = 1.0;
};

/**
 * Community id per node, compacted to 0..k-1 in order of first appearance so
 * the result is stable across runs. A graph with no links puts every node in
 * its own community.
 */
std::vector<int> detectCommunities(std::size_t nodeCount,
                                   const std::vector<CommunityEdge>& edges);

}  // namespace internal
}  // namespace braindump

#endif  // BRAINDUMP_SRC_LOUVAIN_HPP
