#include "graph_wrap.hpp"

#include <utility>

#include "addon_data.hpp"
#include "conversions.hpp"
#include "guard.hpp"

namespace braindump_napi {
namespace {

// Defaults mirror the C++ header's default arguments and shared/types/graph.ts.
constexpr bool kDefaultPretty = false;
constexpr double kDefaultEdgeWeight = 1.0;
constexpr int kDefaultTickIterations = 1;
constexpr int kDefaultSettleIterations = 500;
constexpr int kDefaultSearchLimit = 20;
constexpr int kMinIterations = 0;
constexpr int kMinSearchLimit = 0;
constexpr std::uint32_t kDeterministicSeed = 0;

}  // namespace

// ---------------------------------------------------------------------------
// Class definition + lifecycle
// ---------------------------------------------------------------------------

Napi::Function GraphWrap::Init(Napi::Env env) {
  return DefineClass(
      env, "Graph",
      {
          InstanceMethod<&GraphWrap::ToJSON>("toJSON"),
          InstanceMethod<&GraphWrap::SetName>("setName"),
          InstanceMethod<&GraphWrap::TopologyVersion>("topologyVersion"),
          InstanceMethod<&GraphWrap::NodeOrder>("nodeOrder"),
          InstanceMethod<&GraphWrap::NodeCount>("nodeCount"),
          InstanceMethod<&GraphWrap::EdgeCount>("edgeCount"),
          InstanceMethod<&GraphWrap::AddNode>("addNode"),
          InstanceMethod<&GraphWrap::RemoveNode>("removeNode"),
          InstanceMethod<&GraphWrap::SetNodeLabel>("setNodeLabel"),
          InstanceMethod<&GraphWrap::SetNodeGroup>("setNodeGroup"),
          InstanceMethod<&GraphWrap::GroupMembers>("groupMembers"),
          InstanceMethod<&GraphWrap::AddEdge>("addEdge"),
          InstanceMethod<&GraphWrap::RemoveEdge>("removeEdge"),
          InstanceMethod<&GraphWrap::SetEdgeNote>("setEdgeNote"),
          InstanceMethod<&GraphWrap::SetNodeNote>("setNodeNote"),
          InstanceMethod<&GraphWrap::SyncCell>("syncCell"),
          InstanceMethod<&GraphWrap::RemoveCell>("removeCell"),
          InstanceMethod<&GraphWrap::MergeExtraction>("mergeExtraction"),
          InstanceMethod<&GraphWrap::LayoutConfigure>("layoutConfigure"),
          InstanceMethod<&GraphWrap::LayoutTick>("layoutTick"),
          InstanceMethod<&GraphWrap::LayoutSettle>("layoutSettle"),
          InstanceMethod<&GraphWrap::PinNode>("pinNode"),
          InstanceMethod<&GraphWrap::UnpinNode>("unpinNode"),
          InstanceMethod<&GraphWrap::LayoutReset>("layoutReset"),
          InstanceMethod<&GraphWrap::ComputeMetrics>("computeMetrics"),
          InstanceMethod<&GraphWrap::Components>("components"),
          InstanceMethod<&GraphWrap::ShortestPath>("shortestPath"),
          InstanceMethod<&GraphWrap::Backlinks>("backlinks"),
          InstanceMethod<&GraphWrap::Search>("search"),
      });
}

Napi::Object GraphWrap::Create(Napi::Env env, GraphHolder graph) {
  if (!graph) {
    throw Napi::Error::New(env, "braindump: core returned a null graph");
  }
  AddonData* data = env.GetInstanceData<AddonData>();
  if (data == nullptr) {
    throw Napi::Error::New(env, "braindump: addon instance data is missing");
  }

  // Ownership travels through the External. If the JS constructor never runs,
  // the External's finalizer destroys the holder, so the graph is not leaked.
  auto* holder = new GraphHolder(std::move(graph));
  const Napi::External<GraphHolder> handle = Napi::External<GraphHolder>::New(
      env, holder, [](Napi::Env, GraphHolder* owned) { delete owned; });

  return data->graphConstructor.New({handle});
}

GraphWrap::GraphWrap(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<GraphWrap>(info) {
  const Napi::Env env = info.Env();
  if (!info[0].IsExternal()) {
    throw Napi::TypeError::New(
        env,
        "Graph is not constructible from JS — use createGraph() or "
        "graphFromJSON()");
  }

  GraphHolder* holder = info[0].As<Napi::External<GraphHolder>>().Data();
  if (holder == nullptr || !*holder) {
    throw Napi::Error::New(env, "braindump: graph handle was already consumed");
  }
  graph_ = std::move(*holder);
}

braindump::Graph& GraphWrap::graph(Napi::Env env) const {
  if (!graph_) {
    throw Napi::Error::New(env, "braindump: graph handle is not initialized");
  }
  return *graph_;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

Napi::Value GraphWrap::ToJSON(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const bool pretty = optionalBool(info, 0, "pretty", kDefaultPretty);
  return guarded(env, [&]() -> Napi::Value {
    return Napi::String::New(env, graph(env).toJSON(pretty));
  });
}

Napi::Value GraphWrap::SetEdgeNote(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string edgeId = requireString(info, 0, "edgeId");
  // Empty is meaningful: it clears the description.
  const std::string note =
      info.Length() > 1 && info[1].IsString() ? info[1].As<Napi::String>().Utf8Value() : "";
  return guarded(env, [&]() -> Napi::Value {
    graph(env).setEdgeNote(edgeId, note);
    return env.Undefined();
  });
}

Napi::Value GraphWrap::SetNodeNote(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string nodeId = requireString(info, 0, "nodeId");
  // Empty is meaningful: it clears the description.
  const std::string note =
      info.Length() > 1 && info[1].IsString() ? info[1].As<Napi::String>().Utf8Value() : "";
  return guarded(env, [&]() -> Napi::Value {
    graph(env).setNodeNote(nodeId, note);
    return env.Undefined();
  });
}

Napi::Value GraphWrap::SetNodeLabel(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string nodeId = requireString(info, 0, "nodeId");
  const std::string label = requireString(info, 1, "label");
  return guarded(env, [&]() -> Napi::Value {
    graph(env).setNodeLabel(nodeId, label);
    return env.Undefined();
  });
}

Napi::Value GraphWrap::SetNodeGroup(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string nodeId = requireString(info, 0, "nodeId");
  // Empty is meaningful here — it removes the node from its group — so this
  // deliberately does not use requireString, which rejects an empty string.
  const std::string groupId =
      info.Length() > 1 && info[1].IsString() ? info[1].As<Napi::String>().Utf8Value() : "";
  return guarded(env, [&]() -> Napi::Value {
    graph(env).setNodeGroup(nodeId, groupId);
    return env.Undefined();
  });
}

Napi::Value GraphWrap::GroupMembers(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string groupId = requireString(info, 0, "groupId");
  return guarded(env, [&]() -> Napi::Value {
    const std::vector<std::string> members = graph(env).groupMembers(groupId);
    Napi::Array out = Napi::Array::New(env, members.size());
    for (std::size_t i = 0; i < members.size(); ++i) {
      out.Set(i, Napi::String::New(env, members[i]));
    }
    return out;
  });
}

Napi::Value GraphWrap::SetName(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string name = requireString(info, 0, "name");
  return guarded(env, [&]() -> Napi::Value {
    graph(env).setName(name);
    return env.Undefined();
  });
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

Napi::Value GraphWrap::TopologyVersion(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  return guarded(env, [&]() -> Napi::Value {
    // Exact as a double until 2^53 structural changes — unreachable in practice.
    return Napi::Number::New(env,
                             static_cast<double>(graph(env).topologyVersion()));
  });
}

Napi::Value GraphWrap::NodeOrder(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  return guarded(env, [&]() -> Napi::Value {
    return toStringArray(env, graph(env).nodeOrder());
  });
}

Napi::Value GraphWrap::NodeCount(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  return guarded(env, [&]() -> Napi::Value {
    return Napi::Number::New(env, static_cast<double>(graph(env).nodeCount()));
  });
}

Napi::Value GraphWrap::EdgeCount(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  return guarded(env, [&]() -> Napi::Value {
    return Napi::Number::New(env, static_cast<double>(graph(env).edgeCount()));
  });
}

Napi::Value GraphWrap::AddNode(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string label = requireString(info, 0, "label");
  const braindump::NodeKind kind = requireNodeKind(info, 1, "kind");
  return guarded(env, [&]() -> Napi::Value {
    return Napi::String::New(env, graph(env).addNode(label, kind));
  });
}

Napi::Value GraphWrap::RemoveNode(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string id = requireString(info, 0, "id");
  return guarded(env, [&]() -> Napi::Value {
    return Napi::Boolean::New(env, graph(env).removeNode(id));
  });
}

Napi::Value GraphWrap::AddEdge(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string sourceId = requireString(info, 0, "sourceId");
  const std::string targetId = requireString(info, 1, "targetId");
  const braindump::RelationKind relation = requireRelationKind(info, 2, "relation");
  const double weight =
      optionalPositiveNumber(info, 3, "weight", kDefaultEdgeWeight);
  return guarded(env, [&]() -> Napi::Value {
    return Napi::String::New(
        env, graph(env).addEdge(sourceId, targetId, relation, weight));
  });
}

Napi::Value GraphWrap::RemoveEdge(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string id = requireString(info, 0, "id");
  return guarded(env, [&]() -> Napi::Value {
    return Napi::Boolean::New(env, graph(env).removeEdge(id));
  });
}

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

Napi::Value GraphWrap::SyncCell(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string cellId = requireString(info, 0, "cellId");
  const std::string markdown = requireString(info, 1, "markdown");
  return guarded(env, [&]() -> Napi::Value {
    return toLinkSyncReport(env, graph(env).syncCell(cellId, markdown));
  });
}

Napi::Value GraphWrap::RemoveCell(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string cellId = requireString(info, 0, "cellId");
  return guarded(env, [&]() -> Napi::Value {
    return toLinkSyncReport(env, graph(env).removeCell(cellId));
  });
}

Napi::Value GraphWrap::MergeExtraction(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string cellId = requireString(info, 0, "cellId");
  const std::string extractionJson = requireJsonArgument(info, 1, "result");
  return guarded(env, [&]() -> Napi::Value {
    return toMergeReport(env, graph(env).mergeExtraction(cellId, extractionJson));
  });
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

Napi::Value GraphWrap::LayoutConfigure(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  return guarded(env, [&]() -> Napi::Value {
    braindump::Graph& target = graph(env);
    target.layoutConfigure(
        mergeLayoutParams(info, 0, "params", target.layoutParams()));
    return env.Undefined();
  });
}

Napi::Value GraphWrap::LayoutTick(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const int iterations =
      optionalInt(info, 0, "iterations", kDefaultTickIterations, kMinIterations);
  return guarded(env, [&]() -> Napi::Value {
    return toLayoutFrame(env, graph(env).layoutTick(iterations));
  });
}

Napi::Value GraphWrap::LayoutSettle(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const int maxIterations = optionalInt(info, 0, "maxIterations",
                                        kDefaultSettleIterations, kMinIterations);
  return guarded(env, [&]() -> Napi::Value {
    return toLayoutFrame(env, graph(env).layoutSettle(maxIterations));
  });
}

Napi::Value GraphWrap::PinNode(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string id = requireString(info, 0, "id");
  const double x = requireFiniteNumber(info, 1, "x");
  const double y = requireFiniteNumber(info, 2, "y");
  return guarded(env, [&]() -> Napi::Value {
    graph(env).pinNode(id, x, y);
    return env.Undefined();
  });
}

Napi::Value GraphWrap::UnpinNode(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string id = requireString(info, 0, "id");
  return guarded(env, [&]() -> Napi::Value {
    graph(env).unpinNode(id);
    return env.Undefined();
  });
}

Napi::Value GraphWrap::LayoutReset(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::uint32_t seed =
      optionalUint32(info, 0, "seed", kDeterministicSeed);
  return guarded(env, [&]() -> Napi::Value {
    graph(env).layoutReset(seed);
    return env.Undefined();
  });
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

Napi::Value GraphWrap::ComputeMetrics(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  return guarded(env, [&]() -> Napi::Value {
    graph(env).computeMetrics();
    return env.Undefined();
  });
}

Napi::Value GraphWrap::Components(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  return guarded(env, [&]() -> Napi::Value {
    return toStringMatrix(env, graph(env).components());
  });
}

Napi::Value GraphWrap::ShortestPath(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string fromId = requireString(info, 0, "fromId");
  const std::string toId = requireString(info, 1, "toId");
  return guarded(env, [&]() -> Napi::Value {
    return toStringArray(env, graph(env).shortestPath(fromId, toId));
  });
}

Napi::Value GraphWrap::Backlinks(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string nodeId = requireString(info, 0, "nodeId");
  return guarded(env, [&]() -> Napi::Value {
    return toStringArray(env, graph(env).backlinks(nodeId));
  });
}

Napi::Value GraphWrap::Search(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const std::string query = requireString(info, 0, "query");
  const int limit =
      optionalInt(info, 1, "limit", kDefaultSearchLimit, kMinSearchLimit);
  return guarded(env, [&]() -> Napi::Value {
    return toSearchHits(env, graph(env).search(query, limit));
  });
}

}  // namespace braindump_napi
