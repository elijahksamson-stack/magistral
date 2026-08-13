// PRIVATE. Barnes-Hut quadtree used by the force layout.
//
// The node pool is a member vector that is cleared (never freed) between
// builds, so ticking the simulation performs no heap traffic once warm.

#ifndef BRAINDUMP_SRC_QUADTREE_HPP
#define BRAINDUMP_SRC_QUADTREE_HPP

#include <vector>

namespace braindump {
namespace internal {

/** Sentinel for "this cell holds no single body". */
constexpr int kNoBody = -1;
/** Sentinel for "this quadrant has not been subdivided". */
constexpr int kNoChild = -1;

struct QuadNode {
  double centerX = 0.0;
  double centerY = 0.0;
  double half = 0.0;
  /** Centre of mass. Holds the weighted SUM until QuadTree::build finishes. */
  double comX = 0.0;
  double comY = 0.0;
  double mass = 0.0;
  int child[4] = {kNoChild, kNoChild, kNoChild, kNoChild};
  int body = kNoBody;

  bool isLeaf() const noexcept {
    return child[0] == kNoChild && child[1] == kNoChild && child[2] == kNoChild &&
           child[3] == kNoChild;
  }
};

class QuadTree {
 public:
  /** Rebuild over the given points. Reuses the existing node pool. */
  void build(const std::vector<double>& px, const std::vector<double>& py);

  const std::vector<QuadNode>& nodes() const noexcept { return nodes_; }
  bool isEmpty() const noexcept { return nodes_.empty(); }

 private:
  int createChild(int parentIndex, int quadrant);
  void insert(int bodyIndex, const std::vector<double>& px,
              const std::vector<double>& py);

  std::vector<QuadNode> nodes_;
};

}  // namespace internal
}  // namespace braindump

#endif  // BRAINDUMP_SRC_QUADTREE_HPP
