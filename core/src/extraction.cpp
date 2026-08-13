// mergeExtraction — folding a Claude ✦ Extract Concepts payload into the graph.
//
// Validation happens in full before a single node is touched, so a rejected
// payload can never leave the graph half-merged. Labels resolve through
// normalizeLabel, and every edge a cell asserts is remembered, which together
// make re-running an unchanged extraction a genuine no-op.

#include "graph_impl.hpp"
#include "json_util.hpp"

#include <algorithm>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace braindump {
namespace {

using internal::Json;

constexpr double kDefaultExtractionWeight = 1.0;

struct NodeInput {
  std::string label;
  std::string normalized;
  NodeKind kind = NodeKind::Concept;
  std::optional<std::string> note;
};

struct EdgeInput {
  std::string sourceNormalized;
  std::string targetNormalized;
  RelationKind relation = RelationKind::RelatesTo;
  double weight = kDefaultExtractionWeight;
};

NodeKind parseNodeKind(const std::string& value) {
  try {
    return nodeKindFromString(value);
  } catch (const std::invalid_argument& error) {
    internal::failValidation(std::string("extraction node kind is invalid: ") +
                             error.what());
  }
}

RelationKind parseRelationKind(const std::string& value) {
  try {
    return relationKindFromString(value);
  } catch (const std::invalid_argument& error) {
    internal::failValidation(std::string("extraction edge relation is invalid: ") +
                             error.what());
  }
}

NodeInput parseNodeInput(const Json& json) {
  const std::string context = "extraction node";
  internal::expectObject(json, context);
  internal::rejectUnknownKeys(json, {"label", "kind", "note"}, context);

  NodeInput input;
  input.label = internal::requireNonEmptyString(json, "label", context);
  input.normalized = normalizeLabel(input.label);
  if (input.normalized.empty()) {
    internal::failValidation("extraction node label must normalize to a key");
  }
  input.kind = parseNodeKind(internal::requireString(json, "kind", context));
  input.note = internal::optionalString(json, "note", context);
  return input;
}

EdgeInput parseEdgeInput(const Json& json) {
  const std::string context = "extraction edge";
  internal::expectObject(json, context);
  internal::rejectUnknownKeys(json, {"source", "target", "relation", "weight"},
                              context);

  EdgeInput input;
  input.sourceNormalized =
      normalizeLabel(internal::requireNonEmptyString(json, "source", context));
  input.targetNormalized =
      normalizeLabel(internal::requireNonEmptyString(json, "target", context));
  if (input.sourceNormalized.empty() || input.targetNormalized.empty()) {
    internal::failValidation("extraction edge endpoints must normalize to a key");
  }
  input.relation = parseRelationKind(internal::requireString(json, "relation", context));
  input.weight = internal::optionalPositiveNumber(json, "weight",
                                                  kDefaultExtractionWeight, context);
  return input;
}

void pushUnique(std::vector<std::string>& list, const std::string& value) {
  if (std::find(list.begin(), list.end(), value) == list.end()) {
    list.push_back(value);
  }
}

bool contains(const std::vector<std::string>& list, const std::string& value) {
  return std::find(list.begin(), list.end(), value) != list.end();
}

}  // namespace

MergeReport Graph::Impl::mergeExtraction(const std::string& cellId,
                                         const std::string& extractionJson) {
  if (cellId.empty()) {
    throw GraphError("cell id must contain at least one character");
  }

  // -- phase 1: validate the whole payload ----------------------------------
  const Json payload = internal::parseJson(extractionJson, "extraction result");
  internal::expectObject(payload, "extraction result");
  internal::rejectUnknownKeys(payload, {"nodes", "edges"}, "extraction result");

  const Json& nodesJson =
      internal::requireMember(payload, "nodes", "extraction result");
  internal::expectArray(nodesJson, "extraction result.nodes");
  const Json& edgesJson =
      internal::requireMember(payload, "edges", "extraction result");
  internal::expectArray(edgesJson, "extraction result.edges");

  std::vector<NodeInput> nodeInputs;
  nodeInputs.reserve(nodesJson.size());
  std::unordered_set<std::string> resolvable;
  for (const auto& key : nodeByNormalized) {
    resolvable.insert(key.first);
  }
  for (const Json& entry : nodesJson) {
    NodeInput input = parseNodeInput(entry);
    resolvable.insert(input.normalized);
    nodeInputs.push_back(std::move(input));
  }

  std::vector<EdgeInput> edgeInputs;
  edgeInputs.reserve(edgesJson.size());
  for (const Json& entry : edgesJson) {
    EdgeInput input = parseEdgeInput(entry);
    if (resolvable.count(input.sourceNormalized) == 0 ||
        resolvable.count(input.targetNormalized) == 0) {
      internal::failValidation(
          "extraction edge references a label that is not in the payload and "
          "not already in the graph");
    }
    edgeInputs.push_back(std::move(input));
  }

  // -- phase 2: apply -------------------------------------------------------
  MergeReport report;
  std::vector<std::string>& extractionLinks = cellExtractionLinks[cellId];

  for (const NodeInput& input : nodeInputs) {
    bool wasCreated = false;
    const std::string nodeId = ensureNode(input.label, input.kind, wasCreated);
    if (wasCreated) {
      ++report.nodesAdded;
    } else {
      ++report.nodesMerged;
    }
    const std::size_t index = nodeById.at(nodeId);
    linkCell(index, cellId);
    if (input.note && !nodes[index].note) {
      nodes[index].note = input.note;
    }
    pushUnique(extractionLinks, nodeId);
    pushUnique(report.affectedNodeIds, nodeId);
  }

  for (const EdgeInput& input : edgeInputs) {
    const std::string sourceId = nodes[nodeByNormalized.at(input.sourceNormalized)].id;
    const std::string targetId = nodes[nodeByNormalized.at(input.targetNormalized)].id;
    const std::string key =
        internal::edgeTripleKey(sourceId, targetId, input.relation);

    const auto existing = edgeByTriple.find(key);
    if (existing != edgeByTriple.end() &&
        contains(cellEdgeAssertions[cellId], edges[existing->second].id)) {
      // This cell already asserted this edge: re-merging must change nothing.
      ++report.edgesMerged;
    } else {
      bool wasCreated = false;
      const std::string edgeId =
          ensureEdge(sourceId, targetId, input.relation, input.weight, wasCreated);
      if (wasCreated) {
        ++report.edgesAdded;
      } else {
        ++report.edgesMerged;
      }
      pushUnique(cellEdgeAssertions[cellId], edgeId);
    }

    pushUnique(report.affectedNodeIds, sourceId);
    pushUnique(report.affectedNodeIds, targetId);
  }

  std::sort(report.affectedNodeIds.begin(), report.affectedNodeIds.end());
  touchDocument();
  return report;
}

MergeReport Graph::mergeExtraction(const std::string& cellId,
                                   const std::string& extractionJson) {
  return impl_->mergeExtraction(cellId, extractionJson);
}

}  // namespace braindump
