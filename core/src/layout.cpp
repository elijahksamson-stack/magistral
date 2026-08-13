// Barnes-Hut force-directed layout.
//
// Hot path. Every buffer lives in Impl::layout and is reused across ticks; a
// warm tick allocates nothing. The math is free functions over LayoutScratch so
// the simulation stays independent of graph bookkeeping.

#include "graph_impl.hpp"

#include <unordered_map>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace braindump {

/**
 * Spring strength holding a member to its group.
 *
 * Above a normal edge so membership visibly dominates layout — the whole point
 * of a group is that its members sit together — but not so high that it drags
 * a member away from a genuine relation it also has.
 */
constexpr double kGroupCohesionWeight = 2.0;

/**
 * Membership rest length, as a fraction of linkDistance.
 *
 * Short on purpose: members must sit close enough that the circle drawn around
 * them is tight, and that two groups read as two clusters rather than one
 * interleaved smear.
 */
constexpr double kGroupRestScale = 0.42;

/**
 * How hard two groups push each other apart, per pair of members.
 *
 * Applied as an explicit pass between group nodes rather than as extra charge
 * in the quadtree. Charge was the first attempt and it fought itself: a group
 * repels its OWN members too, so raising it pushed the groups apart and
 * inflated both hulls by the same amount, leaving them overlapping exactly as
 * before. Groups are few, so an O(g^2) pass costs nothing and is exact.
 */
constexpr double kGroupSeparation = 900.0;
/** Below this the pass does nothing; two distant groups need no help. */
constexpr double kGroupSeparationReach = 3.0;
namespace {

/** Converged once mean kinetic energy per node falls below this. */
constexpr double kConvergedEnergyPerNode = 0.01;
/** Floor on pair distance — keeps coincident nodes from producing infinities. */
constexpr double kMinDistance = 0.5;
constexpr double kMinDistanceSquared = kMinDistance * kMinDistance;
/**
 * Plummer softening, as a fraction of linkDistance. A raw 1/r^2 repulsion goes
 * unbounded during a close encounter and kicks the node clean across the
 * canvas; softening caps the peak while leaving the far field untouched.
 */
constexpr double kRepulsionSoftening = 0.25;
/** Ceiling on per-tick displacement, as a fraction of linkDistance. */
constexpr double kMaxSpeedFactor = 0.5;
/** Annealing schedule: alpha reaches kAlphaMin after roughly 300 ticks. */
constexpr double kInitialAlpha = 1.0;
constexpr double kAlphaDecay = 0.0228;
constexpr double kAlphaMin = 0.001;
/** Temperature restored when the author drags a node or the graph grows. */
constexpr double kReheatAlpha = 0.3;
/** layoutReset(0) must be reproducible, so seed 0 maps to a fixed constant. */
constexpr std::uint32_t kDefaultLayoutSeed = 0x9e3779b9U;
/** Initial scatter radius = sqrt(nodeCount) * linkDistance * this. */
constexpr double kResetSpreadFactor = 0.5;
constexpr double kTwoPi = 6.283185307179586;

/** xorshift32 — small, fast, and identical on every platform. */
class Xorshift32 {
 public:
  explicit Xorshift32(std::uint32_t seed) noexcept
      : state_(seed != 0 ? seed : kDefaultLayoutSeed) {}

  std::uint32_t next() noexcept {
    state_ ^= state_ << 13;
    state_ ^= state_ >> 17;
    state_ ^= state_ << 5;
    return state_;
  }

  /** Uniform in [0, 1). */
  double nextUnit() noexcept {
    constexpr double kUint32Scale = 4294967296.0;
    return static_cast<double>(next()) / kUint32Scale;
  }

 private:
  std::uint32_t state_;
};

void accumulateRepulsion(std::size_t bodyIndex, internal::LayoutScratch& scratch,
                         const LayoutParams& params, double softeningSquared) {
  const std::vector<internal::QuadNode>& tree = scratch.tree.nodes();
  const double thetaSquared = params.theta * params.theta;
  const double x = scratch.px[bodyIndex];
  const double y = scratch.py[bodyIndex];
  double forceX = 0.0;
  double forceY = 0.0;

  scratch.traversal.clear();
  scratch.traversal.push_back(0);
  while (!scratch.traversal.empty()) {
    const internal::QuadNode& node = tree[scratch.traversal.back()];
    scratch.traversal.pop_back();
    if (node.mass <= 0.0 || node.body == static_cast<int>(bodyIndex)) {
      continue;
    }

    double dx = x - node.comX;
    double dy = y - node.comY;
    double distanceSquared = dx * dx + dy * dy;

    const double size = node.half * 2.0;
    const bool shouldDescend =
        !node.isLeaf() && size * size >= thetaSquared * distanceSquared;
    if (shouldDescend) {
      for (const int child : node.child) {
        if (child != internal::kNoChild) {
          scratch.traversal.push_back(static_cast<std::uint32_t>(child));
        }
      }
      continue;
    }

    if (distanceSquared < kMinDistanceSquared) {
      // Deterministic nudge: coincident nodes must still separate reproducibly.
      dx = (bodyIndex % 2 == 0) ? kMinDistance : -kMinDistance;
      dy = ((bodyIndex / 2) % 2 == 0) ? kMinDistance : -kMinDistance;
      distanceSquared = dx * dx + dy * dy;
    }

    const double softened = distanceSquared + softeningSquared;
    const double scale =
        params.repulsion * node.mass / (softened * std::sqrt(distanceSquared));
    forceX += scale * dx;
    forceY += scale * dy;
  }

  scratch.fx[bodyIndex] += forceX;
  scratch.fy[bodyIndex] += forceY;
}

/**
 * Push group nodes apart so their circles stay legibly separate.
 *
 * Strength scales with how many members each holds, because that is what sets
 * how wide its ring is drawn. Members are untouched — they are held in place
 * by their own membership springs.
 */
void accumulateGroupSeparation(internal::LayoutScratch& scratch,
                               const std::vector<std::size_t>& groupIndices,
                               const std::vector<double>& groupWeight,
                               const LayoutParams& params) {
  for (std::size_t a = 0; a < groupIndices.size(); ++a) {
    for (std::size_t b = a + 1; b < groupIndices.size(); ++b) {
      const std::size_t i = groupIndices[a];
      const std::size_t j = groupIndices[b];
      const double dx = scratch.px[j] - scratch.px[i];
      const double dy = scratch.py[j] - scratch.py[i];
      const double distanceSquared = std::max(dx * dx + dy * dy, kMinDistanceSquared);
      const double distance = std::sqrt(distanceSquared);

      const double reach = params.linkDistance * kGroupSeparationReach;
      if (distance > reach) continue;

      const double strength =
          kGroupSeparation * groupWeight[a] * groupWeight[b] / distanceSquared;
      const double unitX = dx / distance;
      const double unitY = dy / distance;
      scratch.fx[i] -= strength * unitX;
      scratch.fy[i] -= strength * unitY;
      scratch.fx[j] += strength * unitX;
      scratch.fy[j] += strength * unitY;
    }
  }
}

void accumulateAttraction(internal::LayoutScratch& scratch,
                          const LayoutParams& params) {
  for (const internal::CompiledEdge& edge : scratch.edges) {
    const double dx = scratch.px[edge.target] - scratch.px[edge.source];
    const double dy = scratch.py[edge.target] - scratch.py[edge.source];
    const double distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < kMinDistanceSquared) {
      continue;
    }
    const double distance = std::sqrt(distanceSquared);
    const double magnitude =
        params.attraction * edge.weight * (distance - params.linkDistance * edge.restScale);
    const double unitX = dx / distance;
    const double unitY = dy / distance;
    scratch.fx[edge.source] += magnitude * unitX;
    scratch.fy[edge.source] += magnitude * unitY;
    scratch.fx[edge.target] -= magnitude * unitX;
    scratch.fy[edge.target] -= magnitude * unitY;
  }
}

/** One Euler step. Returns the total kinetic energy after integrating. */
double integrate(internal::LayoutScratch& scratch, const LayoutParams& params) {
  const double maxSpeed = params.linkDistance * kMaxSpeedFactor;
  const double maxSpeedSquared = maxSpeed * maxSpeed;
  const double alpha = scratch.alpha;

  double energy = 0.0;
  for (std::size_t i = 0; i < scratch.px.size(); ++i) {
    if (scratch.isPinned[i] != 0) {
      scratch.vx[i] = 0.0;
      scratch.vy[i] = 0.0;
      continue;
    }
    const double forceX = (scratch.fx[i] - params.gravity * scratch.px[i]) * alpha;
    const double forceY = (scratch.fy[i] - params.gravity * scratch.py[i]) * alpha;
    double velocityX = (scratch.vx[i] + forceX) * params.damping;
    double velocityY = (scratch.vy[i] + forceY) * params.damping;

    double speedSquared = velocityX * velocityX + velocityY * velocityY;
    if (speedSquared > maxSpeedSquared) {
      const double scale = maxSpeed / std::sqrt(speedSquared);
      velocityX *= scale;
      velocityY *= scale;
      speedSquared = maxSpeedSquared;
    }

    scratch.vx[i] = velocityX;
    scratch.vy[i] = velocityY;
    scratch.px[i] += velocityX;
    scratch.py[i] += velocityY;
    energy += speedSquared;
  }
  return energy;
}

double stepSimulation(internal::LayoutScratch& scratch, const LayoutParams& params) {
  if (scratch.alpha > 0.0) {
    const double softening = params.linkDistance * kRepulsionSoftening;
    const double softeningSquared = softening * softening;
    std::fill(scratch.fx.begin(), scratch.fx.end(), 0.0);
    std::fill(scratch.fy.begin(), scratch.fy.end(), 0.0);
    scratch.tree.build(scratch.px, scratch.py);
    for (std::size_t i = 0; i < scratch.px.size(); ++i) {
      accumulateRepulsion(i, scratch, params, softeningSquared);
    }
    accumulateAttraction(scratch, params);
    accumulateGroupSeparation(scratch, scratch.groupIndices, scratch.groupWeight, params);
  }

  const double energy = integrate(scratch, params);
  scratch.alpha *= (1.0 - kAlphaDecay);
  if (scratch.alpha < kAlphaMin) {
    scratch.alpha = 0.0;
  }
  return energy;
}

bool hasConverged(double energy, std::size_t nodeCount) noexcept {
  if (nodeCount == 0) {
    return true;
  }
  return energy / static_cast<double>(nodeCount) < kConvergedEnergyPerNode;
}

}  // namespace

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

void Graph::Impl::syncLayoutBuffers() {
  const std::size_t count = nodes.size();
  if (layout.px.size() != count) {
    layout.px.assign(count, 0.0);
    layout.py.assign(count, 0.0);
    layout.vx.assign(count, 0.0);
    layout.vy.assign(count, 0.0);
    layout.fx.assign(count, 0.0);
    layout.fy.assign(count, 0.0);
    layout.isPinned.assign(count, 0);
    layout.isCompiled = false;
    layout.alpha = kInitialAlpha;  // the graph grew or shrank: re-anneal
  }
  for (std::size_t i = 0; i < count; ++i) {
    layout.px[i] = nodes[i].x;
    layout.py[i] = nodes[i].y;
    layout.isPinned[i] = nodes[i].pinned ? 1 : 0;
  }



  if (layout.isCompiled && layout.compiledTopology == topologyVersion) {
    return;
  }
  layout.edges.clear();
  layout.edges.reserve(edges.size());
  for (const internal::EdgeRecord& edge : edges) {
    const auto source = nodeById.find(edge.source);
    const auto target = nodeById.find(edge.target);
    if (source == nodeById.end() || target == nodeById.end() ||
        source->second == target->second) {
      continue;  // dangling or self edge: no spring to simulate
    }
    layout.edges.push_back(internal::CompiledEdge{
        static_cast<std::uint32_t>(source->second),
        static_cast<std::uint32_t>(target->second), edge.weight, 1.0});
  }
  // Membership is simulated as a spring from each member to its group node.
  // Reusing the edge springs rather than inventing a second force keeps the
  // physics in one place, and it is what pulls a group's members close enough
  // together that the circle drawn around them is tight rather than sprawling.
  for (const internal::NodeRecord& node : nodes) {
    if (node.groupId.empty()) continue;
    const auto member = nodeById.find(node.id);
    const auto group = nodeById.find(node.groupId);
    if (member == nodeById.end() || group == nodeById.end()) continue;
    if (member->second == group->second) continue;

    layout.edges.push_back(internal::CompiledEdge{
        static_cast<std::uint32_t>(member->second),
        static_cast<std::uint32_t>(group->second), kGroupCohesionWeight,
        kGroupRestScale});
  }

  // Group indices and their member counts, cached with the topology so the
  // separation pass does not re-scan every node on every tick.
  layout.groupIndices.clear();
  layout.groupWeight.clear();
  {
    std::unordered_map<std::string, double> memberCount;
    for (const internal::NodeRecord& node : nodes) {
      if (!node.groupId.empty()) memberCount[node.groupId] += 1.0;
    }
    for (std::size_t i = 0; i < nodes.size(); ++i) {
      if (nodes[i].kind != NodeKind::Group) continue;
      const auto found = memberCount.find(nodes[i].id);
      layout.groupIndices.push_back(i);
      // +1 so an empty group still occupies its own minimum circle.
      layout.groupWeight.push_back((found == memberCount.end() ? 0.0 : found->second) + 1.0);
    }
  }

  layout.compiledTopology = topologyVersion;
  layout.isCompiled = true;
}

void Graph::Impl::writeBackPositions() {
  for (std::size_t i = 0; i < nodes.size(); ++i) {
    nodes[i].x = layout.px[i];
    nodes[i].y = layout.py[i];
  }
}

LayoutFrame Graph::Impl::captureFrame(double energy, bool converged,
                                      int iterations) const {
  LayoutFrame frame;
  frame.positions.reserve(nodes.size() * 2);
  for (const internal::NodeRecord& node : nodes) {
    frame.positions.push_back(node.x);
    frame.positions.push_back(node.y);
  }
  frame.energy = energy;
  frame.converged = converged;
  frame.iterations = iterations;
  return frame;
}

LayoutFrame Graph::Impl::layoutTick(int iterations) {
  if (iterations < 0) {
    throw GraphError("layout iterations must not be negative");
  }
  if (nodes.empty() || iterations == 0) {
    return captureFrame(0.0, true, 0);
  }

  syncLayoutBuffers();
  double energy = 0.0;
  for (int i = 0; i < iterations; ++i) {
    energy = stepSimulation(layout, params);
  }
  writeBackPositions();
  return captureFrame(energy, hasConverged(energy, nodes.size()), iterations);
}

LayoutFrame Graph::Impl::layoutSettle(int maxIterations) {
  if (maxIterations < 0) {
    throw GraphError("layout maxIterations must not be negative");
  }
  if (nodes.empty() || maxIterations == 0) {
    return captureFrame(0.0, true, 0);
  }

  syncLayoutBuffers();
  double energy = 0.0;
  int executed = 0;
  bool converged = false;
  while (executed < maxIterations) {
    energy = stepSimulation(layout, params);
    ++executed;
    if (hasConverged(energy, nodes.size())) {
      converged = true;
      break;
    }
  }
  writeBackPositions();
  return captureFrame(energy, converged, executed);
}

void Graph::Impl::layoutReset(std::uint32_t seed) {
  Xorshift32 rng(seed == 0 ? kDefaultLayoutSeed : seed);
  const double radius = std::sqrt(static_cast<double>(nodes.size())) *
                        params.linkDistance * kResetSpreadFactor;

  for (internal::NodeRecord& node : nodes) {
    const double angle = rng.nextUnit() * kTwoPi;
    const double distance = radius * std::sqrt(rng.nextUnit());
    if (node.pinned) {
      continue;  // draw anyway so the sequence stays independent of pinning
    }
    node.x = distance * std::cos(angle);
    node.y = distance * std::sin(angle);
  }

  syncLayoutBuffers();
  std::fill(layout.vx.begin(), layout.vx.end(), 0.0);
  std::fill(layout.vy.begin(), layout.vy.end(), 0.0);
  layout.alpha = kInitialAlpha;
}

void Graph::Impl::reheatLayout() { layout.alpha = std::max(layout.alpha, kReheatAlpha); }

void Graph::Impl::pinNode(const std::string& nodeId, double x, double y) {
  if (!std::isfinite(x) || !std::isfinite(y)) {
    throw GraphError("pinned position must be finite");
  }
  internal::NodeRecord& node = nodes[requireNodeIndex(nodeId)];
  node.pinned = true;
  node.x = x;
  node.y = y;
  reheatLayout();
  touchDocument();
}

void Graph::Impl::unpinNode(const std::string& nodeId) {
  nodes[requireNodeIndex(nodeId)].pinned = false;
  reheatLayout();
  touchDocument();
}

// ---------------------------------------------------------------------------
// Graph — public surface
// ---------------------------------------------------------------------------

LayoutFrame Graph::layoutTick(int iterations) { return impl_->layoutTick(iterations); }

LayoutFrame Graph::layoutSettle(int maxIterations) {
  return impl_->layoutSettle(maxIterations);
}

void Graph::pinNode(const std::string& id, double x, double y) {
  impl_->pinNode(id, x, y);
}

void Graph::unpinNode(const std::string& id) { impl_->unpinNode(id); }

void Graph::layoutReset(std::uint32_t seed) { impl_->layoutReset(seed); }

}  // namespace braindump
