// BrainDump core — THE public C++ header. CONTRACT.
//
// This is the single surface the bindings compile against. `bindings/napi/`
// includes THIS FILE ONLY and nothing else from core/.
//
// Mirrors shared/types/graph.ts and shared/types/addon.ts exactly.
//
// RULE: this header depends on the C++17 standard library and nothing else.
// No Node, no V8, no N-API, no Emscripten. That discipline is what lets the
// same core compile to WASM in the web phase without a rewrite.

#ifndef BRAINDUMP_BRAINDUMP_HPP
#define BRAINDUMP_BRAINDUMP_HPP

#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace braindump {

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

inline constexpr int kSchemaVersion = 1;

/** Ceiling on an edge's description. */
inline constexpr std::size_t kMaxEdgeNoteLength = 2000;

/** Semver of the compiled core, e.g. "0.1.0". */
const char* version();

// ---------------------------------------------------------------------------
// Enumerations — ordinals MUST match the string arrays in shared/types/graph.ts
// ---------------------------------------------------------------------------

enum class NodeKind : std::uint8_t {
  Concept = 0,
  Entity = 1,
  Claim = 2,
  Question = 3,
  Source = 4,
  Metric = 5,
  /**
   * A container, not a claim. A group encloses other nodes on the canvas so
   * the author can say "these belong together" without asserting a relation
   * between every pair. It is the only kind not created by writing a
   * [[wikilink]] — the author makes one directly and drags members into it.
   */
  Group = 6,
};

enum class RelationKind : std::uint8_t {
  RelatesTo = 0,
  Causes = 1,
  PartOf = 2,
  Contradicts = 3,
  Supports = 4,
  DependsOn = 5,
  InstanceOf = 6,
  Mentions = 7,
  /** A influences B without necessarily causing it outright. */
  Affects = 8,
  /** The inverse of Affects, so the claim can be stated from either side. */
  AffectedBy = 9,
};

/** Wire names, e.g. NodeKind::Concept -> "concept". */
const char* toString(NodeKind kind) noexcept;
const char* toString(RelationKind relation) noexcept;

/** Throws std::invalid_argument on an unknown wire name. */
NodeKind nodeKindFromString(const std::string& s);
RelationKind relationKindFromString(const std::string& s);

// ---------------------------------------------------------------------------
// Label normalization — the dedup key
// ---------------------------------------------------------------------------

/**
 * Lowercase, collapse internal whitespace, trim, strip surrounding punctuation.
 * Two labels with the same normalized form ARE the same node.
 *
 *   "The Binding Constraint"  -> "the binding constraint"
 *   "  binding   constraint " -> "binding constraint"
 *   "Binding Constraint!"     -> "binding constraint"
 *
 * Must be ASCII-safe and must not throw.
 */
std::string normalizeLabel(const std::string& label) noexcept;

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

struct LayoutParams {
  double repulsion = 6000.0;
  double attraction = 0.05;
  double gravity = 0.02;
  double damping = 0.85;
  double theta = 0.5;
  double linkDistance = 120.0;
};

struct LayoutFrame {
  /** Flat [x0,y0,x1,y1,...] aligned to nodeOrder(). Size == nodeCount()*2. */
  std::vector<double> positions;
  double energy = 0.0;
  bool converged = false;
  int iterations = 0;
};

struct MergeReport {
  int nodesAdded = 0;
  int nodesMerged = 0;
  int edgesAdded = 0;
  int edgesMerged = 0;
  std::vector<std::string> affectedNodeIds;
};

struct LinkSyncReport {
  std::vector<std::string> createdNodeIds;
  std::vector<std::string> orphanedNodeIds;
  std::vector<std::string> linkedNodeIds;
};

struct SearchHit {
  std::string nodeId;
  std::string label;
  double score = 0.0;
};

/** Thrown for malformed JSON, schema mismatch, and unknown ids. */
class GraphError : public std::runtime_error {
 public:
  explicit GraphError(const std::string& what) : std::runtime_error(what) {}
};

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

class Graph {
 public:
  explicit Graph(std::string name);
  ~Graph();

  // Movable, not copyable — a Graph owns a large adjacency structure and a
  // live simulation state; silent copies would be a performance trap.
  Graph(Graph&&) noexcept;
  Graph& operator=(Graph&&) noexcept;
  Graph(const Graph&) = delete;
  Graph& operator=(const Graph&) = delete;

  // -- serialization ------------------------------------------------------

  /** Throws GraphError on malformed JSON or schemaVersion != kSchemaVersion. */
  static Graph fromJSON(const std::string& json);

  /**
   * Canonical output: keys in a fixed order, arrays sorted by id, doubles
   * formatted deterministically. Two structurally identical graphs MUST
   * produce byte-identical strings — the round-trip test depends on it.
   */
  std::string toJSON(bool pretty = false) const;

  const std::string& id() const noexcept;
  const std::string& name() const noexcept;
  void setName(std::string name);

  // -- topology -----------------------------------------------------------

  /** Increments on every structural change. Renderer caches nodeOrder() on it. */
  std::uint64_t topologyVersion() const noexcept;
  std::vector<std::string> nodeOrder() const;
  std::size_t nodeCount() const noexcept;
  std::size_t edgeCount() const noexcept;

  bool hasNode(const std::string& id) const noexcept;

  /** Returns the id of the new OR existing node — dedup by normalizeLabel. */
  std::string addNode(const std::string& label, NodeKind kind);
  bool removeNode(const std::string& id);

  /**
   * Rename a node.
   *
   * Throws GraphError if the new label normalizes to one another node already
   * holds — labels are the dedup key, so allowing a collision would leave two
   * nodes the core considers the same, which nothing downstream can resolve.
   * Renaming to a different spelling of the SAME node is fine.
   */
  void setNodeLabel(const std::string& nodeId, const std::string& label);

  /**
   * Describe what this concept is, in prose.
   *
   * Normally the line a [[wikilink]] sat on supplies this. A node created
   * directly — a group, or a concept accepted from "Complete the map" — has no
   * such line, and without this the reasoning behind it would be lost at the
   * moment it is accepted. Truncated rather than rejected, like edge notes.
   */
  void setNodeNote(const std::string& nodeId, const std::string& note);

  // -- grouping -------------------------------------------------------------

  /**
   * Put `nodeId` inside `groupId`, or pass an empty groupId to take it out.
   *
   * A node belongs to at most one group, so joining a second one leaves the
   * first. Throws GraphError if either id is unknown, if `groupId` is not a
   * Group, or if `nodeId` is itself a Group — nesting groups is a different
   * feature and silently half-supporting it would be worse than refusing.
   */
  void setNodeGroup(const std::string& nodeId, const std::string& groupId);

  /** Ids of the nodes inside `groupId`, in stable order. */
  std::vector<std::string> groupMembers(const std::string& groupId) const;

  /**
   * Returns the id of the new OR existing edge. Re-asserting an existing
   * (source, target, relation) triple increments its weight rather than
   * creating a duplicate.
   */
  std::string addEdge(const std::string& sourceId,
                      const std::string& targetId,
                      RelationKind relation,
                      double weight = 1.0);
  bool removeEdge(const std::string& id);

  /**
   * Describe what this relationship actually is, in the author's words.
   *
   * A relation kind says "causes"; only prose can say how, under what
   * conditions, and how confident the author is. Truncated to
   * kMaxEdgeNoteLength rather than rejected — losing the tail of a long note
   * is kinder than refusing the write and losing all of it.
   */
  void setEdgeNote(const std::string& edgeId, const std::string& note);

  // -- authoring ----------------------------------------------------------

  /**
   * Reconcile the graph against a cell's [[wikilinks]].
   *
   * This is the ONLY automatic node-creation path, and it fires only on
   * bracketed text the author explicitly typed. Nothing is inferred.
   *
   * Parses [[Label]] and [[Label|display text]]. Idempotent.
   */
  LinkSyncReport syncCell(const std::string& cellId, const std::string& markdown);
  LinkSyncReport removeCell(const std::string& cellId);

  /**
   * Merge a Claude extraction payload (see $defs/extractionResult in
   * shared/schema/graph.schema.json). Labels resolve to existing nodes via
   * normalizeLabel, so re-running on unchanged text is a no-op.
   *
   * Throws GraphError if the payload does not validate.
   */
  MergeReport mergeExtraction(const std::string& cellId,
                              const std::string& extractionJson);

  // -- layout -------------------------------------------------------------

  void layoutConfigure(const LayoutParams& params);
  LayoutParams layoutParams() const noexcept;

  /** Barnes-Hut quadtree N-body step. */
  LayoutFrame layoutTick(int iterations = 1);
  LayoutFrame layoutSettle(int maxIterations = 500);

  void pinNode(const std::string& id, double x, double y);
  void unpinNode(const std::string& id);
  /** Scatter positions, zero velocities. seed == 0 means deterministic. */
  void layoutReset(std::uint32_t seed = 0);

  // -- analysis -----------------------------------------------------------

  /** Recompute degree, PageRank centrality (normalized 0..1), Louvain cluster. */
  void computeMetrics();
  std::vector<std::vector<std::string>> components() const;
  /** Empty when unreachable. Includes both endpoints when reachable. */
  std::vector<std::string> shortestPath(const std::string& fromId,
                                        const std::string& toId) const;
  std::vector<std::string> backlinks(const std::string& nodeId) const;
  std::vector<SearchHit> search(const std::string& query, int limit = 20) const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace braindump

#endif  // BRAINDUMP_BRAINDUMP_HPP
