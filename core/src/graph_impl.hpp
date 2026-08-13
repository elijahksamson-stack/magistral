// BrainDump core — private implementation header.
//
// PRIVATE. Never included by bindings/ — they see braindump.hpp only.
//
// Defines Graph::Impl out-of-line so every core translation unit can implement
// a slice of it: graph.cpp owns topology, index.cpp the link/term index,
// layout.cpp the simulation, algorithms.cpp the analysis, serialize.cpp the
// canonical JSON. Because Impl is a private nested type, all shared logic lives
// on Impl itself rather than in free functions.

#ifndef BRAINDUMP_SRC_GRAPH_IMPL_HPP
#define BRAINDUMP_SRC_GRAPH_IMPL_HPP

#include "quadtree.hpp"
#include "wikilink.hpp"

#include <braindump/braindump.hpp>

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace braindump {
namespace internal {

/**
 * A facet of a concept: a later [[link]] in the same cell, plus the line it
 * appeared on. The note is what makes an export readable — a bare list of
 * labels says what was mentioned, not what was said about it.
 */
struct SubConcept {
  std::string label;
  std::string note;
};

/** Mirrors GraphNode in shared/types/graph.ts. */
struct NodeRecord {
  std::string id;
  std::string label;
  std::string normalizedLabel;
  NodeKind kind = NodeKind::Concept;
  std::vector<std::string> cellIds;
  double x = 0.0;
  double y = 0.0;
  bool pinned = false;
  int degree = 0;
  double centrality = 0.0;
  int cluster = 0;
  std::optional<std::string> color;
  std::optional<std::string> note;
  /**
   * Extra [[links]] from the cell that named this node, each with the prose it
   * sat in. Shown when the reader clicks the node. Labels, not node ids: they
   * are detail on this concept, not concepts of their own.
   */
  std::vector<SubConcept> subConcepts;
  /**
   * The Group node this one sits inside, or empty. A node belongs to at most
   * one group — membership lives on the member rather than as a list on the
   * group so that constraint is structural rather than something every writer
   * has to remember to enforce.
   */
  std::string groupId;
};

/** Mirrors GraphEdge in shared/types/graph.ts. */
struct EdgeRecord {
  std::string id;
  std::string source;
  std::string target;
  RelationKind relation = RelationKind::RelatesTo;
  double weight = 1.0;
  bool directed = true;
  /** The author's description of what this relationship actually is. */
  std::string note;
};

/** Mirrors Cell in shared/types/graph.ts. */
struct CellRecord {
  std::string id;
  int order = 0;
  std::string markdown;
  std::optional<std::string> claudeSessionId;
  std::string createdAt;
  std::string updatedAt;
};

/** Edge flattened to node indices — rebuilt only when topology changes. */
struct CompiledEdge {
  std::uint32_t source = 0;
  std::uint32_t target = 0;
  double weight = 1.0;
  /**
   * Rest length as a fraction of params.linkDistance.
   *
   * Weight alone only scales stiffness, so a strong membership spring still
   * settled its members a full link away from the group — a rosette wide
   * enough that two groups interleaved. Membership needs a SHORTER rest
   * length, which is a different quantity.
   */
  double restScale = 1.0;
};

/**
 * Every buffer the force simulation touches. Owned by Impl and reused across
 * ticks so the inner loop never allocates.
 */
struct LayoutScratch {
  std::vector<double> px;
  std::vector<double> py;
  std::vector<double> vx;
  std::vector<double> vy;
  std::vector<double> fx;
  std::vector<double> fy;
  std::vector<char> isPinned;
  std::vector<CompiledEdge> edges;
  /** Indices of the Group nodes, and how many members each holds. */
  std::vector<std::size_t> groupIndices;
  std::vector<double> groupWeight;
  std::vector<std::uint32_t> traversal;
  QuadTree tree;
  /** topologyVersion the buffers above were sized/compiled for. */
  std::uint64_t compiledTopology = 0;
  bool isCompiled = false;
  /**
   * Annealing temperature, 1 down to 0. Every force is scaled by it, which is
   * what makes the simulation provably settle instead of orbiting forever.
   * Reset by layoutReset and reheated when the author drags or adds a node.
   */
  double alpha = 1.0;
};

/** `relates_to` is a symmetric association; every other relation has direction. */
bool isDirectedRelation(RelationKind relation) noexcept;

/** Dedup key for an edge. Undirected pairs are ordered so (a,b) == (b,a). */
std::string edgeTripleKey(const std::string& sourceId,
                          const std::string& targetId,
                          RelationKind relation);

/** ISO-8601 UTC with millisecond precision, e.g. "2026-08-06T09:41:07.312Z". */
std::string nowIso8601();

/** Split a normalized string into ASCII-alphanumeric terms. */
std::vector<std::string> tokenize(const std::string& normalized);

}  // namespace internal

struct Graph::Impl {
  // -- document -------------------------------------------------------------
  std::string id;
  std::string name;
  std::string createdAt;
  std::string updatedAt;

  // -- storage (dense; ids are stable, indices are not) ----------------------
  std::vector<internal::NodeRecord> nodes;
  std::vector<internal::EdgeRecord> edges;
  std::vector<internal::CellRecord> cells;

  std::unordered_map<std::string, std::size_t> nodeById;
  std::unordered_map<std::string, std::size_t> nodeByNormalized;
  std::unordered_map<std::string, std::size_t> edgeById;
  std::unordered_map<std::string, std::size_t> edgeByTriple;
  std::unordered_map<std::string, std::size_t> cellById;

  /** cellId -> node ids the cell's [[wikilinks]] currently reference. */
  std::unordered_map<std::string, std::vector<std::string>> cellLinks;
  /** cellId -> node ids a Claude extraction attached. Survives a link resync. */
  std::unordered_map<std::string, std::vector<std::string>> cellExtractionLinks;
  /** cellId -> edge ids the cell has already asserted (keeps merges idempotent). */
  std::unordered_map<std::string, std::vector<std::string>> cellEdgeAssertions;

  std::uint64_t topologyVersion = 0;
  std::uint64_t nodeSeq = 0;
  std::uint64_t edgeSeq = 0;

  // -- view -----------------------------------------------------------------
  double zoom = 1.0;
  double panX = 0.0;
  double panY = 0.0;
  LayoutParams params;

  // -- derived --------------------------------------------------------------
  internal::LayoutScratch layout;
  std::map<std::string, std::vector<std::string>> termIndex;
  bool isTermIndexDirty = true;

  // -- graph.cpp ------------------------------------------------------------
  /** Structural change: bumps topologyVersion and updatedAt. */
  void touch();
  /** Content-only change: bumps updatedAt, leaves topologyVersion alone so the
   *  renderer's nodeOrder cache and the running simulation survive a keystroke. */
  void touchDocument();
  std::size_t requireNodeIndex(const std::string& nodeId) const;
  const internal::NodeRecord* findNode(const std::string& nodeId) const;
  std::string ensureNode(const std::string& label, NodeKind kind, bool& wasCreated);
  bool removeNodeById(const std::string& nodeId);
  void setNodeLabel(const std::string& nodeId, const std::string& label);
  void setNodeGroup(const std::string& nodeId, const std::string& groupId);
  std::vector<std::string> groupMembers(const std::string& groupId) const;
  std::string ensureEdge(const std::string& sourceId,
                         const std::string& targetId,
                         RelationKind relation,
                         double weight,
                         bool& wasCreated);
  bool removeEdgeById(const std::string& edgeId);
  void setEdgeNote(const std::string& edgeId, const std::string& note);
  void setNodeNote(const std::string& nodeId, const std::string& note);
  void removeNodeAt(std::size_t index);
  void removeEdgeAt(std::size_t index);
  void linkCell(std::size_t nodeIndex, const std::string& cellId);
  bool unlinkCell(std::size_t nodeIndex, const std::string& cellId);

  /**
   * Delete orphaned nodes nothing else still claims, filtering `orphanIds`
   * down to what was actually removed. Keeps transient typing states
   * ("[[A]]" -> "[[Acc]]" -> "[[Accounting]]") and corrected typos from
   * accumulating as permanent floating nodes.
   */
  void collectOrphans(std::vector<std::string>& orphanIds);
  void rebuildIndices();

  // -- index.cpp ------------------------------------------------------------
  LinkSyncReport syncCell(const std::string& cellId, const std::string& markdown);
  LinkSyncReport dropCell(const std::string& cellId);
  LinkSyncReport reconcileCellLinks(const std::string& cellId,
                                    const std::vector<internal::WikiLinkHit>& links);
  void upsertCellRecord(const std::string& cellId, const std::string& markdown);
  std::vector<SearchHit> search(const std::string& query, int limit);
  std::vector<std::string> backlinks(const std::string& nodeId) const;
  void rebuildTermIndex();

  // -- layout.cpp -----------------------------------------------------------
  LayoutFrame layoutTick(int iterations);
  LayoutFrame layoutSettle(int maxIterations);
  void layoutReset(std::uint32_t seed);
  void pinNode(const std::string& nodeId, double x, double y);
  void unpinNode(const std::string& nodeId);
  void syncLayoutBuffers();
  void writeBackPositions();
  /**
   * Wake a settled simulation so it can act on a change the author just made.
   * Defined beside the annealing constants in layout.cpp, which own the
   * schedule this has to agree with.
   */
  void reheatLayout();
  LayoutFrame captureFrame(double energy, bool converged, int iterations) const;

  // -- algorithms.cpp -------------------------------------------------------
  void computeMetrics();
  std::vector<std::vector<std::string>> components() const;
  std::vector<std::string> shortestPath(const std::string& fromId,
                                        const std::string& toId) const;
  std::vector<std::vector<std::size_t>> buildAdjacency() const;

  // -- serialize.cpp --------------------------------------------------------
  std::string toJSON(bool pretty) const;
  MergeReport mergeExtraction(const std::string& cellId,
                              const std::string& extractionJson);
};

}  // namespace braindump

#endif  // BRAINDUMP_SRC_GRAPH_IMPL_HPP
