// Canonical JSON, matching shared/schema/graph.schema.json exactly.
//
// Canonical means: fixed key order, arrays sorted by id, non-finite doubles
// pinned to 0. Two structurally identical graphs serialize byte-identically,
// which is what makes the round-trip test meaningful.

#include "graph_impl.hpp"
#include "json_util.hpp"

#include <algorithm>
#include <cmath>
#include <unordered_set>
#include <utility>

namespace braindump {
namespace {

using internal::Json;

constexpr int kPrettyIndent = 2;

double finiteOr(double value, double fallback) noexcept {
  return std::isfinite(value) ? value : fallback;
}

double clampUnit(double value) noexcept {
  return std::min(1.0, std::max(0.0, finiteOr(value, 0.0)));
}

/** Numeric tail of an id like "n42", so loaded graphs never reissue an id. */
std::uint64_t idSequence(const std::string& id, char prefix) noexcept {
  if (id.size() < 2 || id[0] != prefix) {
    return 0;
  }
  std::uint64_t value = 0;
  for (std::size_t i = 1; i < id.size(); ++i) {
    const char ch = id[i];
    if (ch < '0' || ch > '9') {
      return 0;
    }
    value = value * 10 + static_cast<std::uint64_t>(ch - '0');
  }
  return value;
}

Json cellToJson(const internal::CellRecord& cell) {
  Json out = Json::object();
  out["id"] = cell.id;
  out["order"] = cell.order;
  out["markdown"] = cell.markdown;
  if (cell.claudeSessionId) {
    out["claudeSessionId"] = *cell.claudeSessionId;
  }
  out["createdAt"] = cell.createdAt;
  out["updatedAt"] = cell.updatedAt;
  return out;
}

Json nodeToJson(const internal::NodeRecord& node) {
  std::vector<std::string> cellIds = node.cellIds;
  std::sort(cellIds.begin(), cellIds.end());

  Json out = Json::object();
  out["id"] = node.id;
  out["label"] = node.label;
  out["normalizedLabel"] = node.normalizedLabel;
  out["kind"] = toString(node.kind);
  out["cellIds"] = cellIds;
  out["x"] = finiteOr(node.x, 0.0);
  out["y"] = finiteOr(node.y, 0.0);
  out["pinned"] = node.pinned;
  out["degree"] = std::max(0, node.degree);
  out["centrality"] = clampUnit(node.centrality);
  out["cluster"] = std::max(0, node.cluster);
  if (node.color) {
    out["color"] = *node.color;
  }
  if (node.note) {
    out["note"] = *node.note;
  }
  // Omitted when empty so a plain concept's JSON stays as small as it was
  // before sub-concepts existed, and older files round-trip unchanged.
  if (!node.groupId.empty()) {
    out["groupId"] = node.groupId;
  }
  if (!node.subConcepts.empty()) {
    Json subs = Json::array();
    for (const internal::SubConcept& sub : node.subConcepts) {
      Json entry = Json::object();
      entry["label"] = sub.label;
      // Omitted when the line said nothing beyond the link itself.
      if (!sub.note.empty()) {
        entry["note"] = sub.note;
      }
      subs.push_back(std::move(entry));
    }
    out["subConcepts"] = std::move(subs);
  }
  return out;
}

Json edgeToJson(const internal::EdgeRecord& edge) {
  Json out = Json::object();
  out["id"] = edge.id;
  out["source"] = edge.source;
  out["target"] = edge.target;
  out["relation"] = toString(edge.relation);
  out["weight"] = finiteOr(edge.weight, 1.0);
  out["directed"] = edge.directed;
  if (!edge.note.empty()) {
    out["note"] = edge.note;
  }
  return out;
}

Json paramsToJson(const LayoutParams& params) {
  Json out = Json::object();
  out["repulsion"] = finiteOr(params.repulsion, 0.0);
  out["attraction"] = finiteOr(params.attraction, 0.0);
  out["gravity"] = finiteOr(params.gravity, 0.0);
  out["damping"] = clampUnit(params.damping);
  out["theta"] = std::max(0.0, finiteOr(params.theta, 0.0));
  out["linkDistance"] = finiteOr(params.linkDistance, 1.0);
  return out;
}

template <typename Record, typename Convert>
Json sortedById(const std::vector<Record>& records, Convert convert) {
  std::vector<const Record*> ordered;
  ordered.reserve(records.size());
  for (const Record& record : records) {
    ordered.push_back(&record);
  }
  std::sort(ordered.begin(), ordered.end(),
            [](const Record* a, const Record* b) { return a->id < b->id; });

  Json array = Json::array();
  for (const Record* record : ordered) {
    array.push_back(convert(*record));
  }
  return array;
}

LayoutParams parseParams(const Json& json) {
  const std::string context = "view.layout.params";
  internal::expectObject(json, context);
  internal::rejectUnknownKeys(
      json,
      {"repulsion", "attraction", "gravity", "damping", "theta", "linkDistance"},
      context);

  LayoutParams params;
  params.repulsion = internal::requireNumber(json, "repulsion", context);
  params.attraction = internal::requireNumber(json, "attraction", context);
  params.gravity = internal::requireNumber(json, "gravity", context);
  params.damping = internal::requireNumber(json, "damping", context);
  params.theta = internal::requireNumber(json, "theta", context);
  params.linkDistance = internal::requireNumber(json, "linkDistance", context);
  if (params.damping < 0.0 || params.damping > 1.0) {
    internal::failValidation(context + ".damping must be within 0..1");
  }
  if (params.theta < 0.0) {
    internal::failValidation(context + ".theta must not be negative");
  }
  if (!(params.linkDistance > 0.0)) {
    internal::failValidation(context + ".linkDistance must be greater than zero");
  }
  return params;
}

internal::CellRecord parseCell(const Json& json) {
  const std::string context = "cell";
  internal::expectObject(json, context);
  internal::rejectUnknownKeys(
      json, {"id", "order", "markdown", "claudeSessionId", "createdAt", "updatedAt"},
      context);

  internal::CellRecord cell;
  cell.id = internal::requireNonEmptyString(json, "id", context);
  cell.order = internal::requireInteger(json, "order", context);
  if (cell.order < 0) {
    internal::failValidation("cell.order must not be negative");
  }
  cell.markdown = internal::requireString(json, "markdown", context);
  cell.claudeSessionId = internal::optionalString(json, "claudeSessionId", context);
  cell.createdAt = internal::requireNonEmptyString(json, "createdAt", context);
  cell.updatedAt = internal::requireNonEmptyString(json, "updatedAt", context);
  return cell;
}

internal::NodeRecord parseNode(const Json& json) {
  const std::string context = "node";
  internal::expectObject(json, context);
  internal::rejectUnknownKeys(json,
                              {"id", "label", "normalizedLabel", "kind", "cellIds",
                               "x", "y", "pinned", "degree", "centrality", "cluster",
                               "color", "note", "subConcepts", "groupId"},
                              context);

  internal::NodeRecord node;
  node.id = internal::requireNonEmptyString(json, "id", context);
  node.label = internal::requireNonEmptyString(json, "label", context);
  node.normalizedLabel =
      internal::requireNonEmptyString(json, "normalizedLabel", context);
  try {
    node.kind = nodeKindFromString(internal::requireString(json, "kind", context));
  } catch (const std::invalid_argument& error) {
    internal::failValidation(std::string("node.kind is invalid: ") + error.what());
  }

  const Json& cellIds = internal::requireMember(json, "cellIds", context);
  internal::expectArray(cellIds, "node.cellIds");
  for (const Json& cellId : cellIds) {
    if (!cellId.is_string()) {
      internal::failValidation("node.cellIds entries must be strings");
    }
    node.cellIds.push_back(cellId.get<std::string>());
  }

  node.x = internal::requireNumber(json, "x", context);
  node.y = internal::requireNumber(json, "y", context);
  node.pinned = internal::requireBoolean(json, "pinned", context);
  node.degree = internal::requireInteger(json, "degree", context);
  node.centrality = internal::requireNumber(json, "centrality", context);
  node.cluster = internal::requireInteger(json, "cluster", context);
  if (node.degree < 0 || node.cluster < 0) {
    internal::failValidation("node.degree and node.cluster must not be negative");
  }
  if (node.centrality < 0.0 || node.centrality > 1.0) {
    internal::failValidation("node.centrality must be within 0..1");
  }
  const auto groupId = internal::optionalString(json, "groupId", context);
  if (groupId) node.groupId = *groupId;
  node.color = internal::optionalString(json, "color", context);
  node.note = internal::optionalString(json, "note", context);

  // Absent in files written before sub-concepts existed, so its absence is
  // valid rather than a schema violation.
  const auto subConcepts = json.find("subConcepts");
  if (subConcepts != json.end() && !subConcepts->is_null()) {
    if (!subConcepts->is_array()) {
      internal::failValidation("node.subConcepts must be an array of strings");
    }
    for (const Json& entry : *subConcepts) {
      // Strings are the pre-note shape; still accepted so older files load.
      if (entry.is_string()) {
        node.subConcepts.push_back(internal::SubConcept{entry.get<std::string>(), ""});
        continue;
      }
      if (!entry.is_object() || !entry.contains("label") || !entry.at("label").is_string()) {
        internal::failValidation("node.subConcepts entries need a string label");
      }
      internal::SubConcept sub;
      sub.label = entry.at("label").get<std::string>();
      const auto note = entry.find("note");
      if (note != entry.end() && note->is_string()) {
        sub.note = note->get<std::string>();
      }
      node.subConcepts.push_back(std::move(sub));
    }
  }
  return node;
}

internal::EdgeRecord parseEdge(const Json& json) {
  const std::string context = "edge";
  internal::expectObject(json, context);
  internal::rejectUnknownKeys(
      json, {"id", "source", "target", "relation", "weight", "directed", "note"}, context);

  internal::EdgeRecord edge;
  edge.id = internal::requireNonEmptyString(json, "id", context);
  edge.source = internal::requireNonEmptyString(json, "source", context);
  edge.target = internal::requireNonEmptyString(json, "target", context);
  try {
    edge.relation =
        relationKindFromString(internal::requireString(json, "relation", context));
  } catch (const std::invalid_argument& error) {
    internal::failValidation(std::string("edge.relation is invalid: ") +
                             error.what());
  }
  edge.weight = internal::requireNumber(json, "weight", context);
  if (!(edge.weight > 0.0)) {
    internal::failValidation("edge.weight must be greater than zero");
  }
  edge.directed = internal::requireBoolean(json, "directed", context);
  const auto note = internal::optionalString(json, "note", context);
  if (note) {
    // Clipped on the way in too: a file could carry a longer note than the
    // editor would ever produce.
    edge.note = note->size() > kMaxEdgeNoteLength ? note->substr(0, kMaxEdgeNoteLength) : *note;
  }
  return edge;
}

}  // namespace

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

std::string Graph::Impl::toJSON(bool pretty) const {
  Json root = Json::object();
  root["schemaVersion"] = kSchemaVersion;
  root["id"] = id;
  root["name"] = name;
  root["createdAt"] = createdAt;
  root["updatedAt"] = updatedAt;
  root["cells"] = sortedById(cells, cellToJson);
  root["nodes"] = sortedById(nodes, nodeToJson);
  root["edges"] = sortedById(edges, edgeToJson);

  Json layoutJson = Json::object();
  layoutJson["kind"] = "force";
  layoutJson["params"] = paramsToJson(params);

  Json viewJson = Json::object();
  viewJson["zoom"] = finiteOr(zoom, 1.0);
  viewJson["panX"] = finiteOr(panX, 0.0);
  viewJson["panY"] = finiteOr(panY, 0.0);
  viewJson["layout"] = std::move(layoutJson);
  root["view"] = std::move(viewJson);

  return pretty ? root.dump(kPrettyIndent) : root.dump();
}

std::string Graph::toJSON(bool pretty) const { return impl_->toJSON(pretty); }

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

Graph Graph::fromJSON(const std::string& json) {
  const Json root = internal::parseJson(json, "graph");
  internal::expectObject(root, "graph");
  internal::rejectUnknownKeys(root,
                              {"schemaVersion", "id", "name", "createdAt",
                               "updatedAt", "cells", "nodes", "edges", "view"},
                              "graph");

  const int schemaVersion = internal::requireInteger(root, "schemaVersion", "graph");
  if (schemaVersion != kSchemaVersion) {
    internal::failValidation("unsupported schemaVersion " +
                             std::to_string(schemaVersion) + "; expected " +
                             std::to_string(kSchemaVersion));
  }

  Graph graph(internal::requireNonEmptyString(root, "name", "graph"));
  Impl& impl = *graph.impl_;
  impl.id = internal::requireNonEmptyString(root, "id", "graph");
  impl.createdAt = internal::requireNonEmptyString(root, "createdAt", "graph");
  impl.updatedAt = internal::requireNonEmptyString(root, "updatedAt", "graph");

  const Json& cells = internal::requireMember(root, "cells", "graph");
  internal::expectArray(cells, "graph.cells");
  for (const Json& cell : cells) {
    impl.cells.push_back(parseCell(cell));
  }

  const Json& nodes = internal::requireMember(root, "nodes", "graph");
  internal::expectArray(nodes, "graph.nodes");
  for (const Json& node : nodes) {
    impl.nodes.push_back(parseNode(node));
  }

  const Json& edges = internal::requireMember(root, "edges", "graph");
  internal::expectArray(edges, "graph.edges");
  for (const Json& edge : edges) {
    impl.edges.push_back(parseEdge(edge));
  }

  const Json& view = internal::requireMember(root, "view", "graph");
  internal::expectObject(view, "view");
  internal::rejectUnknownKeys(view, {"zoom", "panX", "panY", "layout"}, "view");
  impl.zoom = internal::requireNumber(view, "zoom", "view");
  if (!(impl.zoom > 0.0)) {
    internal::failValidation("view.zoom must be greater than zero");
  }
  impl.panX = internal::requireNumber(view, "panX", "view");
  impl.panY = internal::requireNumber(view, "panY", "view");

  const Json& layout = internal::requireMember(view, "layout", "view");
  internal::expectObject(layout, "view.layout");
  internal::rejectUnknownKeys(layout, {"kind", "params"}, "view.layout");
  if (internal::requireString(layout, "kind", "view.layout") != "force") {
    internal::failValidation("view.layout.kind must be 'force'");
  }
  impl.params = parseParams(internal::requireMember(layout, "params", "view.layout"));

  // -- referential integrity ------------------------------------------------
  std::unordered_set<std::string> nodeIds;
  std::unordered_set<std::string> normalizedLabels;
  for (const internal::NodeRecord& node : impl.nodes) {
    if (!nodeIds.insert(node.id).second) {
      internal::failValidation("duplicate node id '" + node.id + "'");
    }
    if (!normalizedLabels.insert(node.normalizedLabel).second) {
      internal::failValidation("duplicate normalizedLabel '" +
                               node.normalizedLabel + "'");
    }
    impl.nodeSeq = std::max(impl.nodeSeq, idSequence(node.id, 'n'));
  }
  std::unordered_set<std::string> cellIds;
  for (const internal::CellRecord& cell : impl.cells) {
    if (!cellIds.insert(cell.id).second) {
      internal::failValidation("duplicate cell id '" + cell.id + "'");
    }
  }
  std::unordered_set<std::string> edgeIds;
  for (const internal::EdgeRecord& edge : impl.edges) {
    if (!edgeIds.insert(edge.id).second) {
      internal::failValidation("duplicate edge id '" + edge.id + "'");
    }
    if (nodeIds.count(edge.source) == 0 || nodeIds.count(edge.target) == 0) {
      internal::failValidation("edge '" + edge.id + "' references an unknown node");
    }
    impl.edgeSeq = std::max(impl.edgeSeq, idSequence(edge.id, 'e'));
  }

  impl.rebuildIndices();
  return graph;
}

}  // namespace braindump
