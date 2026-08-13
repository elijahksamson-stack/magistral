// Graph lifecycle and topology: dedup-on-insert nodes, weight-merging edges,
// cascading removal, and the topologyVersion every derived cache keys off.

#include "graph_impl.hpp"
#include "wikilink.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <ctime>
#include <utility>

namespace braindump {
namespace {

/** Golden-angle spiral seeding keeps freshly added nodes from stacking up. */
constexpr double kGoldenAngleRadians = 2.399963229728653;
constexpr double kInitialRadiusStep = 24.0;

constexpr std::uint64_t kFnvOffsetBasis = 1469598103934665603ULL;
constexpr std::uint64_t kFnvPrime = 1099511628211ULL;

constexpr int kIsoTimestampBufferSize = 32;
constexpr int kMillisPerSecond = 1000;

std::uint64_t fnv1a64(const std::string& text) noexcept {
  std::uint64_t hash = kFnvOffsetBasis;
  for (const char raw : text) {
    hash ^= static_cast<std::uint64_t>(static_cast<unsigned char>(raw));
    hash *= kFnvPrime;
  }
  return hash;
}

std::string toHex64(std::uint64_t value) {
  char buffer[17];
  std::snprintf(buffer, sizeof(buffer), "%016llx",
                static_cast<unsigned long long>(value));
  return std::string(buffer);
}

void requireFinite(double value, const char* field) {
  if (!std::isfinite(value)) {
    throw GraphError(std::string(field) + " must be a finite number");
  }
}

using CellLinkMap = std::unordered_map<std::string, std::vector<std::string>>;

void forgetCellLink(CellLinkMap& links, const std::string& cellId,
                    const std::string& nodeId) {
  const auto entry = links.find(cellId);
  if (entry == links.end()) {
    return;
  }
  entry->second.erase(
      std::remove(entry->second.begin(), entry->second.end(), nodeId),
      entry->second.end());
}

}  // namespace

namespace internal {

std::string nowIso8601() {
  using Clock = std::chrono::system_clock;
  const auto now = Clock::now();
  const auto epochMillis =
      std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch())
          .count();
  const std::time_t seconds =
      static_cast<std::time_t>(epochMillis / kMillisPerSecond);
  const int millis = static_cast<int>(epochMillis % kMillisPerSecond);

  std::tm utc{};
#if defined(_WIN32)
  gmtime_s(&utc, &seconds);
#else
  gmtime_r(&seconds, &utc);
#endif

  char buffer[kIsoTimestampBufferSize];
  std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday, utc.tm_hour,
                utc.tm_min, utc.tm_sec, millis);
  return std::string(buffer);
}

}  // namespace internal

// ---------------------------------------------------------------------------
// Impl — topology
// ---------------------------------------------------------------------------

void Graph::Impl::touch() {
  ++topologyVersion;
  updatedAt = internal::nowIso8601();
}

void Graph::Impl::touchDocument() { updatedAt = internal::nowIso8601(); }

const internal::NodeRecord* Graph::Impl::findNode(const std::string& nodeId) const {
  const auto it = nodeById.find(nodeId);
  if (it == nodeById.end()) {
    return nullptr;
  }
  return &nodes[it->second];
}

std::size_t Graph::Impl::requireNodeIndex(const std::string& nodeId) const {
  const auto it = nodeById.find(nodeId);
  if (it == nodeById.end()) {
    throw GraphError("unknown node id: '" + nodeId + "'");
  }
  return it->second;
}

std::string Graph::Impl::ensureNode(const std::string& label, NodeKind kind,
                                    bool& wasCreated) {
  const std::string normalized = normalizeLabel(label);
  if (normalized.empty()) {
    throw GraphError("node label must contain at least one character");
  }

  const auto existing = nodeByNormalized.find(normalized);
  if (existing != nodeByNormalized.end()) {
    wasCreated = false;
    return nodes[existing->second].id;
  }

  internal::NodeRecord record;
  record.id = "n" + std::to_string(++nodeSeq);
  record.label = label;
  record.normalizedLabel = normalized;
  record.kind = kind;
  const double angle = kGoldenAngleRadians * static_cast<double>(nodeSeq);
  const double radius = kInitialRadiusStep * std::sqrt(static_cast<double>(nodeSeq));
  record.x = radius * std::cos(angle);
  record.y = radius * std::sin(angle);

  const std::size_t index = nodes.size();
  nodeById.emplace(record.id, index);
  nodeByNormalized.emplace(normalized, index);
  const std::string createdId = record.id;
  nodes.push_back(std::move(record));

  isTermIndexDirty = true;
  wasCreated = true;
  touch();
  return createdId;
}

void Graph::Impl::removeNodeAt(std::size_t index) {
  // Deleting a group releases its members rather than orphaning them into a
  // group id that no longer resolves.
  if (nodes[index].kind == NodeKind::Group) {
    const std::string goneId = nodes[index].id;
    for (internal::NodeRecord& node : nodes) {
      if (node.groupId == goneId) node.groupId.clear();
    }
  }

  nodeById.erase(nodes[index].id);
  nodeByNormalized.erase(nodes[index].normalizedLabel);

  const std::size_t last = nodes.size() - 1;
  if (index != last) {
    nodes[index] = std::move(nodes[last]);
    nodeById[nodes[index].id] = index;
    nodeByNormalized[nodes[index].normalizedLabel] = index;
  }
  nodes.pop_back();
}

void Graph::Impl::setNodeLabel(const std::string& nodeId, const std::string& label) {
  const std::size_t index = requireNodeIndex(nodeId);

  const std::string normalized = normalizeLabel(label);
  if (normalized.empty()) {
    throw GraphError("node label must contain at least one character");
  }

  const auto clash = nodeByNormalized.find(normalized);
  if (clash != nodeByNormalized.end() && clash->second != index) {
    // Labels ARE the dedup key. Two nodes sharing one would be the same node
    // as far as every lookup is concerned, and nothing downstream could tell
    // them apart again.
    throw GraphError("another node already uses the label: " + label);
  }

  if (nodes[index].label == label && nodes[index].normalizedLabel == normalized) {
    return;
  }

  // The normalized index is keyed by the OLD label; re-key it before writing.
  nodeByNormalized.erase(nodes[index].normalizedLabel);
  nodes[index].label = label;
  nodes[index].normalizedLabel = normalized;
  nodeByNormalized.emplace(normalized, index);

  // Content, not topology: the running layout and the renderer's cached node
  // order both survive a rename untouched.
  isTermIndexDirty = true;
  touchDocument();
}

void Graph::Impl::setEdgeNote(const std::string& edgeId, const std::string& note) {
  const auto found = edgeById.find(edgeId);
  if (found == edgeById.end()) {
    throw GraphError("unknown edge id: " + edgeId);
  }
  // Truncated rather than rejected: losing the tail of an over-long note is
  // kinder than refusing the write and losing the whole thing.
  const std::string clipped =
      note.size() > kMaxEdgeNoteLength ? note.substr(0, kMaxEdgeNoteLength) : note;
  if (edges[found->second].note == clipped) {
    return;
  }
  edges[found->second].note = clipped;
  // Content, not topology: the running simulation and the renderer's cached
  // node order both survive this untouched.
  touchDocument();
}

void Graph::Impl::setNodeNote(const std::string& nodeId, const std::string& note) {
  const std::size_t index = requireNodeIndex(nodeId);
  // Same cap and the same reasoning as edge notes: keep what fits rather than
  // refuse the write and lose all of it.
  const std::string clipped =
      note.size() > kMaxEdgeNoteLength ? note.substr(0, kMaxEdgeNoteLength) : note;
  if (nodes[index].note == clipped) {
    return;
  }
  nodes[index].note = clipped;
  // Content, not topology: the running layout and the renderer's cached node
  // order both survive this untouched. The term index is not dirtied either —
  // it indexes labels only, and widening it to notes would quietly change what
  // every existing search returns.
  touchDocument();
}

void Graph::Impl::setNodeGroup(const std::string& nodeId, const std::string& groupId) {
  const std::size_t nodeIndex = requireNodeIndex(nodeId);

  if (nodes[nodeIndex].kind == NodeKind::Group) {
    // Nesting is a different feature. Half-supporting it — accepting the write
    // but never drawing the nesting — would be worse than refusing outright.
    throw GraphError("a group cannot be placed inside another group");
  }

  if (groupId.empty()) {
    if (!nodes[nodeIndex].groupId.empty()) {
      nodes[nodeIndex].groupId.clear();
      touch();
    }
    return;
  }

  const std::size_t groupIndex = requireNodeIndex(groupId);
  if (nodes[groupIndex].kind != NodeKind::Group) {
    throw GraphError("target of setNodeGroup is not a group node");
  }
  if (nodes[nodeIndex].groupId == groupId) {
    return;  // already a member; nothing changed
  }

  // Assignment rather than insertion: joining a second group leaves the first,
  // which is what "belongs to at most one" means.
  nodes[nodeIndex].groupId = groupId;
  touch();
}

std::vector<std::string> Graph::Impl::groupMembers(const std::string& groupId) const {
  std::vector<std::string> members;
  if (groupId.empty()) {
    return members;
  }
  for (const internal::NodeRecord& node : nodes) {
    if (node.groupId == groupId) {
      members.push_back(node.id);
    }
  }
  return members;
}

bool Graph::Impl::removeNodeById(const std::string& nodeId) {
  const auto found = nodeById.find(nodeId);
  if (found == nodeById.end()) {
    return false;
  }

  std::vector<std::string> incidentEdgeIds;
  for (const internal::EdgeRecord& edge : edges) {
    if (edge.source == nodeId || edge.target == nodeId) {
      incidentEdgeIds.push_back(edge.id);
    }
  }
  for (const std::string& edgeId : incidentEdgeIds) {
    removeEdgeById(edgeId);
  }

  // Index may have shifted while edges were removed — re-read it.
  const std::size_t index = nodeById.at(nodeId);
  for (const std::string& cellId : nodes[index].cellIds) {
    forgetCellLink(cellLinks, cellId, nodeId);
    forgetCellLink(cellExtractionLinks, cellId, nodeId);
  }

  removeNodeAt(index);
  isTermIndexDirty = true;
  touch();
  return true;
}

std::string Graph::Impl::ensureEdge(const std::string& sourceId,
                                    const std::string& targetId,
                                    RelationKind relation, double weight,
                                    bool& wasCreated) {
  requireNodeIndex(sourceId);
  requireNodeIndex(targetId);
  requireFinite(weight, "edge weight");
  if (weight <= 0.0) {
    throw GraphError("edge weight must be greater than zero");
  }

  const std::string key = internal::edgeTripleKey(sourceId, targetId, relation);
  const auto existing = edgeByTriple.find(key);
  if (existing != edgeByTriple.end()) {
    internal::EdgeRecord& edge = edges[existing->second];
    edge.weight += weight;
    wasCreated = false;
    touch();
    return edge.id;
  }

  internal::EdgeRecord record;
  record.id = "e" + std::to_string(++edgeSeq);
  record.source = sourceId;
  record.target = targetId;
  record.relation = relation;
  record.weight = weight;
  record.directed = internal::isDirectedRelation(relation);

  const std::size_t index = edges.size();
  edgeById.emplace(record.id, index);
  edgeByTriple.emplace(key, index);
  const std::string createdId = record.id;
  edges.push_back(std::move(record));

  wasCreated = true;
  touch();
  return createdId;
}

void Graph::Impl::removeEdgeAt(std::size_t index) {
  const internal::EdgeRecord& doomed = edges[index];
  edgeById.erase(doomed.id);
  edgeByTriple.erase(
      internal::edgeTripleKey(doomed.source, doomed.target, doomed.relation));

  const std::size_t last = edges.size() - 1;
  if (index != last) {
    edges[index] = std::move(edges[last]);
    edgeById[edges[index].id] = index;
    edgeByTriple[internal::edgeTripleKey(edges[index].source, edges[index].target,
                                         edges[index].relation)] = index;
  }
  edges.pop_back();
}

bool Graph::Impl::removeEdgeById(const std::string& edgeId) {
  const auto found = edgeById.find(edgeId);
  if (found == edgeById.end()) {
    return false;
  }
  removeEdgeAt(found->second);

  for (auto& entry : cellEdgeAssertions) {
    entry.second.erase(
        std::remove(entry.second.begin(), entry.second.end(), edgeId),
        entry.second.end());
  }
  touch();
  return true;
}

void Graph::Impl::linkCell(std::size_t nodeIndex, const std::string& cellId) {
  std::vector<std::string>& cellIds = nodes[nodeIndex].cellIds;
  if (std::find(cellIds.begin(), cellIds.end(), cellId) == cellIds.end()) {
    cellIds.push_back(cellId);
  }
}

bool Graph::Impl::unlinkCell(std::size_t nodeIndex, const std::string& cellId) {
  std::vector<std::string>& cellIds = nodes[nodeIndex].cellIds;
  const auto it = std::find(cellIds.begin(), cellIds.end(), cellId);
  if (it == cellIds.end()) {
    return false;
  }
  cellIds.erase(it);
  return cellIds.empty();
}

void Graph::Impl::rebuildIndices() {
  nodeById.clear();
  nodeByNormalized.clear();
  edgeById.clear();
  edgeByTriple.clear();
  cellById.clear();
  cellLinks.clear();
  cellExtractionLinks.clear();

  for (std::size_t i = 0; i < nodes.size(); ++i) {
    nodeById.emplace(nodes[i].id, i);
    nodeByNormalized.emplace(nodes[i].normalizedLabel, i);
  }

  // A loaded document does not say which links came from [[wikilinks]] and
  // which from an extraction, so re-derive the split: anything the markdown
  // still mentions is a wikilink, the remainder is extraction-owned.
  for (const internal::CellRecord& cell : cells) {
    std::vector<std::string>& linked = cellLinks[cell.id];
    for (const std::string& label : internal::parseWikiLinks(cell.markdown)) {
      const auto node = nodeByNormalized.find(normalizeLabel(label));
      if (node == nodeByNormalized.end()) {
        continue;
      }
      const internal::NodeRecord& record = nodes[node->second];
      const bool isLinked = std::find(record.cellIds.begin(), record.cellIds.end(),
                                      cell.id) != record.cellIds.end();
      if (isLinked && std::find(linked.begin(), linked.end(), record.id) ==
                          linked.end()) {
        linked.push_back(record.id);
      }
    }
  }
  for (const internal::NodeRecord& node : nodes) {
    for (const std::string& cellId : node.cellIds) {
      const std::vector<std::string>& linked = cellLinks[cellId];
      if (std::find(linked.begin(), linked.end(), node.id) == linked.end()) {
        cellExtractionLinks[cellId].push_back(node.id);
      }
    }
  }

  for (std::size_t i = 0; i < edges.size(); ++i) {
    edgeById.emplace(edges[i].id, i);
    edgeByTriple.emplace(
        internal::edgeTripleKey(edges[i].source, edges[i].target, edges[i].relation),
        i);
  }
  for (std::size_t i = 0; i < cells.size(); ++i) {
    cellById.emplace(cells[i].id, i);
  }
  isTermIndexDirty = true;
  layout.isCompiled = false;
}

// ---------------------------------------------------------------------------
// Graph — public surface
// ---------------------------------------------------------------------------

Graph::Graph(std::string name) : impl_(new Impl()) {
  if (name.empty()) {
    throw GraphError("graph name must contain at least one character");
  }
  impl_->name = std::move(name);
  impl_->createdAt = internal::nowIso8601();
  impl_->updatedAt = impl_->createdAt;
  impl_->id = "g" + toHex64(fnv1a64(impl_->name + "|" + impl_->createdAt));
}

Graph::~Graph() = default;
Graph::Graph(Graph&&) noexcept = default;
Graph& Graph::operator=(Graph&&) noexcept = default;

const std::string& Graph::id() const noexcept { return impl_->id; }
const std::string& Graph::name() const noexcept { return impl_->name; }

void Graph::setName(std::string name) {
  if (name.empty()) {
    throw GraphError("graph name must contain at least one character");
  }
  impl_->name = std::move(name);
  impl_->updatedAt = internal::nowIso8601();
}

std::uint64_t Graph::topologyVersion() const noexcept {
  return impl_->topologyVersion;
}

std::vector<std::string> Graph::nodeOrder() const {
  std::vector<std::string> order;
  order.reserve(impl_->nodes.size());
  for (const internal::NodeRecord& node : impl_->nodes) {
    order.push_back(node.id);
  }
  return order;
}

std::size_t Graph::nodeCount() const noexcept { return impl_->nodes.size(); }
std::size_t Graph::edgeCount() const noexcept { return impl_->edges.size(); }

bool Graph::hasNode(const std::string& id) const noexcept {
  return impl_->nodeById.find(id) != impl_->nodeById.end();
}

std::string Graph::addNode(const std::string& label, NodeKind kind) {
  bool wasCreated = false;
  return impl_->ensureNode(label, kind, wasCreated);
}

bool Graph::removeNode(const std::string& id) { return impl_->removeNodeById(id); }

void Graph::setNodeLabel(const std::string& nodeId, const std::string& label) {
  impl_->setNodeLabel(nodeId, label);
}

void Graph::setEdgeNote(const std::string& edgeId, const std::string& note) {
  impl_->setEdgeNote(edgeId, note);
}

void Graph::setNodeNote(const std::string& nodeId, const std::string& note) {
  impl_->setNodeNote(nodeId, note);
}

void Graph::setNodeGroup(const std::string& nodeId, const std::string& groupId) {
  impl_->setNodeGroup(nodeId, groupId);
}

std::vector<std::string> Graph::groupMembers(const std::string& groupId) const {
  return impl_->groupMembers(groupId);
}

std::string Graph::addEdge(const std::string& sourceId, const std::string& targetId,
                           RelationKind relation, double weight) {
  bool wasCreated = false;
  return impl_->ensureEdge(sourceId, targetId, relation, weight, wasCreated);
}

bool Graph::removeEdge(const std::string& id) { return impl_->removeEdgeById(id); }

void Graph::layoutConfigure(const LayoutParams& params) {
  requireFinite(params.repulsion, "repulsion");
  requireFinite(params.attraction, "attraction");
  requireFinite(params.gravity, "gravity");
  requireFinite(params.damping, "damping");
  requireFinite(params.theta, "theta");
  requireFinite(params.linkDistance, "linkDistance");
  if (params.damping < 0.0 || params.damping > 1.0) {
    throw GraphError("damping must be within 0..1");
  }
  if (params.theta < 0.0) {
    throw GraphError("theta must not be negative");
  }
  if (params.linkDistance <= 0.0) {
    throw GraphError("linkDistance must be greater than zero");
  }
  impl_->params = params;
  // Re-heat, exactly as pinning does. Alpha decays to zero as a layout settles
  // and every force is scaled by it, so a settled graph silently ignores its
  // own parameters — the sliders moved the graph once and were dead ever
  // after. A parameter the author just changed has to be visible.
  impl_->reheatLayout();
}

LayoutParams Graph::layoutParams() const noexcept { return impl_->params; }

}  // namespace braindump
