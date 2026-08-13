// Barnes-Hut quadtree construction.

#include "quadtree.hpp"

#include <algorithm>
#include <cstddef>

namespace braindump {
namespace internal {
namespace {

/** Coincident points would subdivide forever; past this depth a cell buckets. */
constexpr int kMaxDepth = 32;
/** Keeps the root square strictly larger than the point cloud. */
constexpr double kBoundsPadding = 1.0;

int quadrantOf(const QuadNode& node, double x, double y) noexcept {
  const int east = x >= node.centerX ? 1 : 0;
  const int north = y >= node.centerY ? 2 : 0;
  return east | north;
}

QuadNode makeNode(double centerX, double centerY, double half) noexcept {
  QuadNode node;
  node.centerX = centerX;
  node.centerY = centerY;
  node.half = half;
  return node;
}

}  // namespace

int QuadTree::createChild(int parentIndex, int quadrant) {
  const QuadNode& parent = nodes_[static_cast<std::size_t>(parentIndex)];
  const double quarter = parent.half * 0.5;
  const double offsetX = (quadrant & 1) != 0 ? quarter : -quarter;
  const double offsetY = (quadrant & 2) != 0 ? quarter : -quarter;
  const QuadNode child =
      makeNode(parent.centerX + offsetX, parent.centerY + offsetY, quarter);

  const int childIndex = static_cast<int>(nodes_.size());
  nodes_.push_back(child);
  nodes_[static_cast<std::size_t>(parentIndex)].child[quadrant] = childIndex;
  return childIndex;
}

void QuadTree::insert(int bodyIndex, const std::vector<double>& px,
                      const std::vector<double>& py) {
  const double x = px[static_cast<std::size_t>(bodyIndex)];
  const double y = py[static_cast<std::size_t>(bodyIndex)];

  int current = 0;
  int depth = 0;
  for (;;) {
    QuadNode& node = nodes_[static_cast<std::size_t>(current)];
    if (node.mass == 0.0) {
      node.body = bodyIndex;
      node.mass = 1.0;
      node.comX = x;
      node.comY = y;
      return;
    }

    if (node.body != kNoBody && depth < kMaxDepth) {
      const int displaced = node.body;
      node.body = kNoBody;
      const int quadrant =
          quadrantOf(node, px[static_cast<std::size_t>(displaced)],
                     py[static_cast<std::size_t>(displaced)]);
      const int childIndex = createChild(current, quadrant);
      QuadNode& child = nodes_[static_cast<std::size_t>(childIndex)];
      child.body = displaced;
      child.mass = 1.0;
      child.comX = px[static_cast<std::size_t>(displaced)];
      child.comY = py[static_cast<std::size_t>(displaced)];
    }

    // `node` may dangle after createChild grew the pool — re-seat the reference.
    QuadNode& internalNode = nodes_[static_cast<std::size_t>(current)];
    internalNode.mass += 1.0;
    internalNode.comX += x;
    internalNode.comY += y;
    if (depth >= kMaxDepth) {
      // Depth-capped bucket: the body lives on only through the mass sums.
      internalNode.body = kNoBody;
      return;
    }

    const int quadrant = quadrantOf(internalNode, x, y);
    const int existing = internalNode.child[quadrant];
    current = existing != kNoChild ? existing : createChild(current, quadrant);
    ++depth;
  }
}

void QuadTree::build(const std::vector<double>& px, const std::vector<double>& py) {
  nodes_.clear();
  const std::size_t count = px.size();
  if (count == 0) {
    return;
  }

  double minX = px[0];
  double maxX = px[0];
  double minY = py[0];
  double maxY = py[0];
  for (std::size_t i = 1; i < count; ++i) {
    minX = std::min(minX, px[i]);
    maxX = std::max(maxX, px[i]);
    minY = std::min(minY, py[i]);
    maxY = std::max(maxY, py[i]);
  }

  const double half =
      std::max((maxX - minX), (maxY - minY)) * 0.5 + kBoundsPadding;
  nodes_.reserve(count * 2);
  nodes_.push_back(makeNode((minX + maxX) * 0.5, (minY + maxY) * 0.5, half));

  for (std::size_t i = 0; i < count; ++i) {
    insert(static_cast<int>(i), px, py);
  }

  for (QuadNode& node : nodes_) {
    if (node.mass > 0.0) {
      node.comX /= node.mass;
      node.comY /= node.mass;
    }
  }
}

}  // namespace internal
}  // namespace braindump
