// BrainDump WebAssembly bindings — PHASE 2 SCAFFOLD. Not built today.
//
// emcc is not installed on the dev machine, so nothing here is compiled by
// `npm run build:native`. It exists to prove the seam: the SAME
// core/src/*.cpp that node-gyp compiles into build/Release/braindump.node is
// compiled here by emcc, and only this file changes. The core never learns
// which host it is running in.
//
// The whole translation unit is guarded so that a stray include of this file
// in a native build is a no-op rather than a compile error.
//
// See bindings/wasm/README.md for the phase-2 checklist.

#ifdef __EMSCRIPTEN__

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "braindump/braindump.hpp"

namespace braindump_wasm {
namespace {

using emscripten::val;

/**
 * Same exception firewall as the N-API layer: GraphError is normalized to a
 * std::runtime_error carrying the original message, which Emscripten surfaces
 * to JS as an Error when built with -fexceptions.
 */
template <typename Fn>
auto guarded(Fn&& fn) -> decltype(fn()) {
  try {
    return fn();
  } catch (const braindump::GraphError& error) {
    throw std::runtime_error(error.what());
  }
}

val toStringArray(const std::vector<std::string>& values) {
  val array = val::array();
  for (std::size_t i = 0; i < values.size(); ++i) {
    array.set(i, val(values[i]));
  }
  return array;
}

val toStringMatrix(const std::vector<std::vector<std::string>>& groups) {
  val array = val::array();
  for (std::size_t i = 0; i < groups.size(); ++i) {
    array.set(i, toStringArray(groups[i]));
  }
  return array;
}

val toLinkSyncReport(const braindump::LinkSyncReport& report) {
  val result = val::object();
  result.set("createdNodeIds", toStringArray(report.createdNodeIds));
  result.set("orphanedNodeIds", toStringArray(report.orphanedNodeIds));
  result.set("linkedNodeIds", toStringArray(report.linkedNodeIds));
  return result;
}

val toMergeReport(const braindump::MergeReport& report) {
  val result = val::object();
  result.set("nodesAdded", report.nodesAdded);
  result.set("nodesMerged", report.nodesMerged);
  result.set("edgesAdded", report.edgesAdded);
  result.set("edgesMerged", report.edgesMerged);
  result.set("affectedNodeIds", toStringArray(report.affectedNodeIds));
  return result;
}

val toSearchHits(const std::vector<braindump::SearchHit>& hits) {
  val array = val::array();
  for (std::size_t i = 0; i < hits.size(); ++i) {
    val hit = val::object();
    hit.set("nodeId", val(hits[i].nodeId));
    hit.set("label", val(hits[i].label));
    hit.set("score", hits[i].score);
    array.set(i, hit);
  }
  return array;
}

double patchedField(const val& patch, const char* key, double current) {
  const val field = patch[key];
  return field.isUndefined() || field.isNull() ? current : field.as<double>();
}

}  // namespace

/**
 * Mirrors NativeGraph from shared/types/addon.ts, method for method.
 *
 * embind has no default arguments, so every parameter is explicit here; the
 * phase-2 JS wrapper applies the same defaults the N-API layer does.
 */
class WasmGraph {
 public:
  explicit WasmGraph(const std::string& name) : graph_(name) {}

  static WasmGraph* fromJSON(const std::string& json) {
    return guarded([&] {
      return new WasmGraph(braindump::Graph::fromJSON(json));
    });
  }

  std::string toJSON(bool pretty) const {
    return guarded([&] { return graph_.toJSON(pretty); });
  }

  // -- topology -------------------------------------------------------------

  double topologyVersion() const {
    return static_cast<double>(graph_.topologyVersion());
  }
  val nodeOrder() const { return toStringArray(graph_.nodeOrder()); }
  double nodeCount() const { return static_cast<double>(graph_.nodeCount()); }
  double edgeCount() const { return static_cast<double>(graph_.edgeCount()); }

  std::string addNode(const std::string& label, const std::string& kind) {
    return guarded(
        [&] { return graph_.addNode(label, braindump::nodeKindFromString(kind)); });
  }
  bool removeNode(const std::string& id) {
    return guarded([&] { return graph_.removeNode(id); });
  }
  std::string addEdge(const std::string& sourceId,
                      const std::string& targetId,
                      const std::string& relation,
                      double weight) {
    return guarded([&] {
      return graph_.addEdge(sourceId, targetId,
                            braindump::relationKindFromString(relation), weight);
    });
  }
  bool removeEdge(const std::string& id) {
    return guarded([&] { return graph_.removeEdge(id); });
  }

  // -- authoring ------------------------------------------------------------

  val syncCell(const std::string& cellId, const std::string& markdown) {
    return guarded(
        [&] { return toLinkSyncReport(graph_.syncCell(cellId, markdown)); });
  }
  val removeCell(const std::string& cellId) {
    return guarded([&] { return toLinkSyncReport(graph_.removeCell(cellId)); });
  }
  val mergeExtraction(const std::string& cellId, const val& result) {
    const std::string json =
        val::global("JSON").call<std::string>("stringify", result);
    return guarded(
        [&] { return toMergeReport(graph_.mergeExtraction(cellId, json)); });
  }

  // -- layout ---------------------------------------------------------------

  void layoutConfigure(const val& params) {
    const braindump::LayoutParams current = graph_.layoutParams();
    braindump::LayoutParams merged = current;
    merged.repulsion = patchedField(params, "repulsion", current.repulsion);
    merged.attraction = patchedField(params, "attraction", current.attraction);
    merged.gravity = patchedField(params, "gravity", current.gravity);
    merged.damping = patchedField(params, "damping", current.damping);
    merged.theta = patchedField(params, "theta", current.theta);
    merged.linkDistance =
        patchedField(params, "linkDistance", current.linkDistance);
    graph_.layoutConfigure(merged);
  }

  val layoutTick(int iterations) {
    return guarded([&] {
      frame_ = graph_.layoutTick(iterations);
      return frameToVal();
    });
  }
  val layoutSettle(int maxIterations) {
    return guarded([&] {
      frame_ = graph_.layoutSettle(maxIterations);
      return frameToVal();
    });
  }

  void pinNode(const std::string& id, double x, double y) {
    guarded([&] {
      graph_.pinNode(id, x, y);
      return 0;
    });
  }
  void unpinNode(const std::string& id) {
    guarded([&] {
      graph_.unpinNode(id);
      return 0;
    });
  }
  void layoutReset(std::uint32_t seed) { graph_.layoutReset(seed); }

  // -- analysis -------------------------------------------------------------

  void computeMetrics() { graph_.computeMetrics(); }
  val components() const { return toStringMatrix(graph_.components()); }
  val shortestPath(const std::string& fromId, const std::string& toId) const {
    return guarded([&] { return toStringArray(graph_.shortestPath(fromId, toId)); });
  }
  val backlinks(const std::string& nodeId) const {
    return guarded([&] { return toStringArray(graph_.backlinks(nodeId)); });
  }
  val search(const std::string& query, int limit) const {
    return guarded([&] { return toSearchHits(graph_.search(query, limit)); });
  }

 private:
  explicit WasmGraph(braindump::Graph&& graph) : graph_(std::move(graph)) {}

  /**
   * `positions` is a VIEW into wasm linear memory, not a copy — the same
   * "one buffer per tick, no per-node marshalling" contract the N-API layer
   * honours. It is invalidated by the next tick and by memory growth, so a
   * caller that retains it must .slice() first.
   */
  val frameToVal() const {
    val result = val::object();
    result.set("positions",
               val(emscripten::typed_memory_view(frame_.positions.size(),
                                                 frame_.positions.data())));
    result.set("energy", frame_.energy);
    result.set("converged", frame_.converged);
    result.set("iterations", frame_.iterations);
    return result;
  }

  braindump::Graph graph_;
  braindump::LayoutFrame frame_;
};

namespace {

WasmGraph* createGraph(const std::string& name) { return new WasmGraph(name); }

std::string version() {
  const char* semver = braindump::version();
  if (semver == nullptr) {
    throw std::runtime_error("braindump: core version() returned null");
  }
  return semver;
}

int schemaVersion() { return braindump::kSchemaVersion; }

}  // namespace
}  // namespace braindump_wasm

EMSCRIPTEN_BINDINGS(braindump) {
  using braindump_wasm::WasmGraph;

  emscripten::class_<WasmGraph>("Graph")
      .constructor<std::string>()
      .class_function("fromJSON", &WasmGraph::fromJSON,
                      emscripten::allow_raw_pointers())
      .function("toJSON", &WasmGraph::toJSON)
      .function("topologyVersion", &WasmGraph::topologyVersion)
      .function("nodeOrder", &WasmGraph::nodeOrder)
      .function("nodeCount", &WasmGraph::nodeCount)
      .function("edgeCount", &WasmGraph::edgeCount)
      .function("addNode", &WasmGraph::addNode)
      .function("removeNode", &WasmGraph::removeNode)
      .function("addEdge", &WasmGraph::addEdge)
      .function("removeEdge", &WasmGraph::removeEdge)
      .function("syncCell", &WasmGraph::syncCell)
      .function("removeCell", &WasmGraph::removeCell)
      .function("mergeExtraction", &WasmGraph::mergeExtraction)
      .function("layoutConfigure", &WasmGraph::layoutConfigure)
      .function("layoutTick", &WasmGraph::layoutTick)
      .function("layoutSettle", &WasmGraph::layoutSettle)
      .function("pinNode", &WasmGraph::pinNode)
      .function("unpinNode", &WasmGraph::unpinNode)
      .function("layoutReset", &WasmGraph::layoutReset)
      .function("computeMetrics", &WasmGraph::computeMetrics)
      .function("components", &WasmGraph::components)
      .function("shortestPath", &WasmGraph::shortestPath)
      .function("backlinks", &WasmGraph::backlinks)
      .function("search", &WasmGraph::search);

  emscripten::function("createGraph", &braindump_wasm::createGraph,
                       emscripten::allow_raw_pointers());
  emscripten::function("version", &braindump_wasm::version);
  emscripten::function("schemaVersion", &braindump_wasm::schemaVersion);
}

#endif  // __EMSCRIPTEN__
