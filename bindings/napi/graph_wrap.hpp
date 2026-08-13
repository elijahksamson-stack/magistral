// JS class wrapping braindump::Graph — implements NativeGraph from
// shared/types/addon.ts, method for method.

#ifndef BRAINDUMP_NAPI_GRAPH_WRAP_HPP
#define BRAINDUMP_NAPI_GRAPH_WRAP_HPP

#include <napi.h>

#include <memory>

#include "braindump/braindump.hpp"

namespace braindump_napi {

/** Sole owner of a native Graph. Graph is move-only, so it lives on the heap. */
using GraphHolder = std::unique_ptr<braindump::Graph>;

class GraphWrap : public Napi::ObjectWrap<GraphWrap> {
 public:
  /** Builds the JS class. Call once per environment, from module init. */
  static Napi::Function Init(Napi::Env env);

  /** Wrap an owned native graph in a fresh JS object. */
  static Napi::Object Create(Napi::Env env, GraphHolder graph);

  /** Not callable from JS — only Create() may supply the native handle. */
  explicit GraphWrap(const Napi::CallbackInfo& info);

 private:
  braindump::Graph& graph(Napi::Env env) const;

  // lifecycle
  Napi::Value ToJSON(const Napi::CallbackInfo& info);
  Napi::Value SetName(const Napi::CallbackInfo& info);
  Napi::Value SetNodeLabel(const Napi::CallbackInfo& info);
  Napi::Value SetNodeGroup(const Napi::CallbackInfo& info);
  Napi::Value SetEdgeNote(const Napi::CallbackInfo& info);
  Napi::Value SetNodeNote(const Napi::CallbackInfo& info);
  Napi::Value GroupMembers(const Napi::CallbackInfo& info);

  // topology
  Napi::Value TopologyVersion(const Napi::CallbackInfo& info);
  Napi::Value NodeOrder(const Napi::CallbackInfo& info);
  Napi::Value NodeCount(const Napi::CallbackInfo& info);
  Napi::Value EdgeCount(const Napi::CallbackInfo& info);
  Napi::Value AddNode(const Napi::CallbackInfo& info);
  Napi::Value RemoveNode(const Napi::CallbackInfo& info);
  Napi::Value AddEdge(const Napi::CallbackInfo& info);
  Napi::Value RemoveEdge(const Napi::CallbackInfo& info);

  // authoring
  Napi::Value SyncCell(const Napi::CallbackInfo& info);
  Napi::Value RemoveCell(const Napi::CallbackInfo& info);
  Napi::Value MergeExtraction(const Napi::CallbackInfo& info);

  // layout
  Napi::Value LayoutConfigure(const Napi::CallbackInfo& info);
  Napi::Value LayoutTick(const Napi::CallbackInfo& info);
  Napi::Value LayoutSettle(const Napi::CallbackInfo& info);
  Napi::Value PinNode(const Napi::CallbackInfo& info);
  Napi::Value UnpinNode(const Napi::CallbackInfo& info);
  Napi::Value LayoutReset(const Napi::CallbackInfo& info);

  // analysis
  Napi::Value ComputeMetrics(const Napi::CallbackInfo& info);
  Napi::Value Components(const Napi::CallbackInfo& info);
  Napi::Value ShortestPath(const Napi::CallbackInfo& info);
  Napi::Value Backlinks(const Napi::CallbackInfo& info);
  Napi::Value Search(const Napi::CallbackInfo& info);

  GraphHolder graph_;
};

}  // namespace braindump_napi

#endif  // BRAINDUMP_NAPI_GRAPH_WRAP_HPP
