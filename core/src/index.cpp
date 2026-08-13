// The cell <-> node index: reconciling a cell's [[wikilinks]] against the
// graph, plus the inverted term index behind search() and backlinks().

#include "graph_impl.hpp"
#include "wikilink.hpp"

#include <algorithm>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace braindump {

/**
 * Remove orphaned nodes that nothing else still claims.
 *
 * Without this, every intermediate state of typing a link survives forever.
 * Typing "[[Accounting]]" fires a debounced syncCell at "[[A]]", "[[Acc]]",
 * "[[Accou]]"… and each tick strands its predecessor as a floating node.
 * Typos are worse: correcting "[[Accsdounting]]" to "[[Accounting]]" would
 * leave the misspelling in the graph permanently. The author's intent is the
 * text that is on screen NOW, not every keystroke that led to it.
 *
 * THE RULE: a concept exists exactly as long as some cell mentions it.
 *
 * An earlier version also spared any node carrying an edge, a pin, a colour, or
 * a note, reasoning that those represented author investment worth protecting.
 * That was wrong in practice, and reported as a bug: deleting "[[introduction]]"
 * from a cell left the concept on the canvas because an edge had been drawn from
 * it, with nothing on screen explaining why. A concept that outlives the text
 * naming it is a ghost, and the author has no way to get rid of it.
 *
 * Position, colour, notes and edges are decoration on a concept whose existence
 * is asserted by the text. When the last assertion goes, so does the concept —
 * and removeNodeById cascades to its incident edges, since an edge to a concept
 * that no longer exists asserts nothing.
 *
 * Extraction-attached nodes are unaffected: reconcileCellLinks never orphans
 * them in the first place, so they never reach this function.
 *
 * `orphanIds` is filtered in place to what was actually removed, so the
 * caller's report tells the UI the truth.
 */
void Graph::Impl::collectOrphans(std::vector<std::string>& orphanIds) {
  std::vector<std::string> collected;
  collected.reserve(orphanIds.size());

  for (const std::string& nodeId : orphanIds) {
    const auto index = nodeById.find(nodeId);
    if (index == nodeById.end()) {
      continue;  // already gone
    }
    // A group is created by the author directly, not by writing a link, so it
    // has no cells to lose and must never be collected for lacking them.
    if (nodes[index->second].kind == NodeKind::Group) {
      continue;
    }
    // The one survival condition: another cell still asserts this concept.
    if (!nodes[index->second].cellIds.empty()) {
      continue;
    }
    if (removeNodeById(nodeId)) {
      collected.push_back(nodeId);
    }
  }
  orphanIds = std::move(collected);
}

namespace {

/** A term that merely starts with the query token counts for less than a hit. */
constexpr double kPrefixMatchScore = 0.6;
constexpr double kExactMatchScore = 1.0;
constexpr double kMaxScore = 1.0;

bool byScoreThenLabel(const SearchHit& a, const SearchHit& b) {
  if (a.score != b.score) {
    return a.score > b.score;
  }
  if (a.label != b.label) {
    return a.label < b.label;
  }
  return a.nodeId < b.nodeId;
}

}  // namespace

// ---------------------------------------------------------------------------
// Cell index
// ---------------------------------------------------------------------------

void Graph::Impl::upsertCellRecord(const std::string& cellId,
                                   const std::string& markdown) {
  const auto found = cellById.find(cellId);
  if (found != cellById.end()) {
    internal::CellRecord& cell = cells[found->second];
    if (cell.markdown != markdown) {
      cell.markdown = markdown;
      cell.updatedAt = internal::nowIso8601();
    }
    return;
  }

  internal::CellRecord record;
  record.id = cellId;
  record.order = static_cast<int>(cells.size());
  record.markdown = markdown;
  record.createdAt = internal::nowIso8601();
  record.updatedAt = record.createdAt;
  cellById.emplace(cellId, cells.size());
  cells.push_back(std::move(record));
}

/**
 * Reconcile a cell against its [[wikilinks]].
 *
 * ONE CELL PRODUCES ONE NODE. The first link names the cell — it is the
 * concept the cell is about, and the only thing that appears on the canvas.
 * Every later link is a sub-concept recorded ON that node and revealed when
 * the reader clicks it.
 *
 * The alternative — a node per link — is what shipped first, and it made the
 * graph unreadable the moment a distilled document arrived: eighteen nodes
 * with no edges from a single cell, none of which was the cell's subject.
 * A cell is a thought; a thought is one node.
 */
LinkSyncReport Graph::Impl::reconcileCellLinks(
    const std::string& cellId, const std::vector<internal::WikiLinkHit>& links) {
  LinkSyncReport report;

  const std::vector<std::string> previous = cellLinks.count(cellId) > 0
                                                ? cellLinks.at(cellId)
                                                : std::vector<std::string>{};

  std::vector<std::string> current;
  if (!links.empty()) {
    bool wasCreated = false;
    const std::string nodeId = ensureNode(links.front().label, NodeKind::Concept, wasCreated);
    if (wasCreated) {
      report.createdNodeIds.push_back(nodeId);
    }
    const std::size_t index = nodeById.at(nodeId);
    linkCell(index, cellId);

    // The line the FIRST link sat on describes the node itself.
    if (!links.front().note.empty()) {
      nodes[index].note = links.front().note;
    }

    // Sub-concepts are deduplicated against each other and against the node's
    // own label, so "[[X]] ... [[X]]" does not list X beneath itself.
    std::vector<internal::SubConcept> subConcepts;
    std::unordered_set<std::string> seen{normalizeLabel(links.front().label)};
    for (std::size_t i = 1; i < links.size(); ++i) {
      const std::string normalized = normalizeLabel(links[i].label);
      if (normalized.empty() || seen.count(normalized) > 0) {
        continue;
      }
      seen.insert(normalized);
      subConcepts.push_back(internal::SubConcept{links[i].label, links[i].note});
    }
    nodes[index].subConcepts = std::move(subConcepts);

    current.push_back(nodeId);
  }

  const std::unordered_set<std::string> retained(current.begin(), current.end());
  const auto extraction = cellExtractionLinks.find(cellId);
  for (const std::string& nodeId : previous) {
    if (retained.count(nodeId) > 0) {
      continue;
    }
    // A node an extraction also attached stays attached — the author deleting a
    // [[wikilink]] does not retract what Claude found in the same cell.
    if (extraction != cellExtractionLinks.end() &&
        std::find(extraction->second.begin(), extraction->second.end(), nodeId) !=
            extraction->second.end()) {
      continue;
    }
    const auto index = nodeById.find(nodeId);
    if (index == nodeById.end()) {
      continue;  // node was removed independently; nothing left to unlink
    }
    if (unlinkCell(index->second, cellId)) {
      report.orphanedNodeIds.push_back(nodeId);
    }
  }

  cellLinks[cellId] = current;
  report.linkedNodeIds = std::move(current);
  collectOrphans(report.orphanedNodeIds);
  return report;
}

LinkSyncReport Graph::Impl::syncCell(const std::string& cellId,
                                     const std::string& markdown) {
  if (cellId.empty()) {
    throw GraphError("cell id must contain at least one character");
  }
  upsertCellRecord(cellId, markdown);
  LinkSyncReport report =
      reconcileCellLinks(cellId, internal::parseWikiLinkHits(markdown));
  touchDocument();
  return report;
}

LinkSyncReport Graph::Impl::dropCell(const std::string& cellId) {
  if (cellId.empty()) {
    throw GraphError("cell id must contain at least one character");
  }

  LinkSyncReport report;
  std::vector<std::string> attached = cellLinks.count(cellId) > 0
                                          ? cellLinks.at(cellId)
                                          : std::vector<std::string>{};
  if (cellExtractionLinks.count(cellId) > 0) {
    for (const std::string& nodeId : cellExtractionLinks.at(cellId)) {
      if (std::find(attached.begin(), attached.end(), nodeId) == attached.end()) {
        attached.push_back(nodeId);
      }
    }
  }
  for (const std::string& nodeId : attached) {
    const auto index = nodeById.find(nodeId);
    if (index == nodeById.end()) {
      continue;
    }
    if (unlinkCell(index->second, cellId)) {
      report.orphanedNodeIds.push_back(nodeId);
    }
  }

  collectOrphans(report.orphanedNodeIds);

  cellLinks.erase(cellId);
  cellExtractionLinks.erase(cellId);
  // Assertions are per-cell; dropping them lets a re-added cell re-assert its
  // extraction edges instead of being silently deduplicated against a ghost.
  cellEdgeAssertions.erase(cellId);

  const auto found = cellById.find(cellId);
  if (found != cellById.end()) {
    cells.erase(cells.begin() + static_cast<std::ptrdiff_t>(found->second));
    cellById.clear();
    for (std::size_t i = 0; i < cells.size(); ++i) {
      cells[i].order = static_cast<int>(i);  // orders stay contiguous and 0-based
      cellById.emplace(cells[i].id, i);
    }
  }

  touchDocument();
  return report;
}

// ---------------------------------------------------------------------------
// Term index
// ---------------------------------------------------------------------------

void Graph::Impl::rebuildTermIndex() {
  termIndex.clear();
  for (const internal::NodeRecord& node : nodes) {
    std::unordered_set<std::string> emitted;
    for (const std::string& term : internal::tokenize(node.normalizedLabel)) {
      if (emitted.insert(term).second) {
        termIndex[term].push_back(node.id);
      }
    }
  }
  isTermIndexDirty = false;
}

std::vector<SearchHit> Graph::Impl::search(const std::string& query, int limit) {
  if (limit <= 0) {
    return {};
  }
  const std::string normalizedQuery = normalizeLabel(query);
  const std::vector<std::string> queryTerms = internal::tokenize(normalizedQuery);
  if (queryTerms.empty()) {
    return {};
  }
  if (isTermIndexDirty) {
    rebuildTermIndex();
  }

  std::unordered_map<std::string, double> totals;
  for (const std::string& term : queryTerms) {
    std::unordered_map<std::string, double> best;
    const auto exact = termIndex.find(term);
    if (exact != termIndex.end()) {
      for (const std::string& nodeId : exact->second) {
        best[nodeId] = kExactMatchScore;
      }
    }
    for (auto it = termIndex.lower_bound(term);
         it != termIndex.end() && it->first.compare(0, term.size(), term) == 0;
         ++it) {
      for (const std::string& nodeId : it->second) {
        double& slot = best[nodeId];
        slot = std::max(slot, kPrefixMatchScore);
      }
    }
    for (const auto& entry : best) {
      totals[entry.first] += entry.second;
    }
  }

  const double denominator = static_cast<double>(queryTerms.size());
  std::vector<SearchHit> hits;
  hits.reserve(totals.size());
  for (const auto& entry : totals) {
    const internal::NodeRecord* node = findNode(entry.first);
    if (node == nullptr) {
      continue;
    }
    const bool isExactLabel = node->normalizedLabel == normalizedQuery;
    const double score =
        isExactLabel ? kMaxScore : std::min(kMaxScore, entry.second / denominator);
    hits.push_back(SearchHit{node->id, node->label, score});
  }

  std::sort(hits.begin(), hits.end(), byScoreThenLabel);
  if (hits.size() > static_cast<std::size_t>(limit)) {
    hits.resize(static_cast<std::size_t>(limit));
  }
  return hits;
}

std::vector<std::string> Graph::Impl::backlinks(const std::string& nodeId) const {
  requireNodeIndex(nodeId);

  std::vector<std::string> sources;
  for (const internal::EdgeRecord& edge : edges) {
    if (edge.target == nodeId) {
      sources.push_back(edge.source);
      continue;
    }
    // An undirected association is a reference in both directions.
    if (!edge.directed && edge.source == nodeId) {
      sources.push_back(edge.target);
    }
  }

  std::sort(sources.begin(), sources.end());
  sources.erase(std::unique(sources.begin(), sources.end()), sources.end());
  sources.erase(std::remove(sources.begin(), sources.end(), nodeId), sources.end());
  return sources;
}

// ---------------------------------------------------------------------------
// Graph — public surface
// ---------------------------------------------------------------------------

LinkSyncReport Graph::syncCell(const std::string& cellId,
                               const std::string& markdown) {
  return impl_->syncCell(cellId, markdown);
}

LinkSyncReport Graph::removeCell(const std::string& cellId) {
  return impl_->dropCell(cellId);
}

std::vector<SearchHit> Graph::search(const std::string& query, int limit) const {
  return impl_->search(query, limit);
}

std::vector<std::string> Graph::backlinks(const std::string& nodeId) const {
  return impl_->backlinks(nodeId);
}

}  // namespace braindump
