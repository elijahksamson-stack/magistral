// The cell <-> node index: [[wikilink]] parsing, idempotent syncCell,
// search and backlinks.

#include "doctest.h"

#include <braindump/braindump.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>

using braindump::Graph;
using braindump::GraphError;
using braindump::LinkSyncReport;
using braindump::NodeKind;
using braindump::RelationKind;
using braindump::SearchHit;

namespace {

std::vector<std::string> labelsOf(const Graph& graph) {
  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  std::vector<std::string> labels;
  for (const nlohmann::json& node : document.at("nodes")) {
    labels.push_back(node.at("label").get<std::string>());
  }
  std::sort(labels.begin(), labels.end());
  return labels;
}

std::vector<std::string> cellIdsOf(const Graph& graph, const std::string& label) {
  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  for (const nlohmann::json& node : document.at("nodes")) {
    if (node.at("label") == label) {
      return node.at("cellIds").get<std::vector<std::string>>();
    }
  }
  return {};
}

/** Sub-concepts are stored on the node; absent when the cell had only one link. */
std::vector<std::string> subConceptsOf(const Graph& graph, const std::string& label) {
  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  for (const nlohmann::json& node : document.at("nodes")) {
    if (node.at("label") == label) {
      std::vector<std::string> labels;
      if (node.contains("subConcepts")) {
        for (const nlohmann::json& sub : node.at("subConcepts")) {
          labels.push_back(sub.at("label").get<std::string>());
        }
      }
      return labels;
    }
  }
  return {};
}

/** The note recorded for one sub-concept, or "" when it carries none. */
std::string subNoteOf(const Graph& graph, const std::string& nodeLabel,
                      const std::string& subLabel) {
  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  for (const nlohmann::json& node : document.at("nodes")) {
    if (node.at("label") != nodeLabel || !node.contains("subConcepts")) continue;
    for (const nlohmann::json& sub : node.at("subConcepts")) {
      if (sub.at("label") == subLabel) {
        return sub.contains("note") ? sub.at("note").get<std::string>() : std::string{};
      }
    }
  }
  return {};
}

/** The node's own note, taken from the line its naming link sat on. */
std::string noteOf(const Graph& graph, const std::string& label) {
  const nlohmann::json document = nlohmann::json::parse(graph.toJSON());
  for (const nlohmann::json& node : document.at("nodes")) {
    if (node.at("label") == label) {
      return node.contains("note") ? node.at("note").get<std::string>() : std::string{};
    }
  }
  return {};
}

}  // namespace

TEST_CASE("a sub-concept carries what follows it, up to the next link") {
  Graph graph("notes");
  graph.syncCell(
      "c1",
      "[[grid-energy prices]] primer for founders.\n"
      "- [[Data center power demand]] is doubling roughly every two years.\n"
      "- A gas plant's cost is defined by its [[heat rate]] (MMBtu per MWh).\n");

  CHECK(graph.nodeCount() == 1);
  CHECK(subNoteOf(graph, "grid-energy prices", "Data center power demand") ==
        "is doubling roughly every two years.");
  // Only what follows the link. The clause AHEAD of it on its own line
  // introduces the line, and belongs to no concept's description.
  CHECK(subNoteOf(graph, "grid-energy prices", "heat rate") == "(MMBtu per MWh).");
  // The naming link describes the node itself.
  CHECK(noteOf(graph, "grid-energy prices") == "primer for founders.");
}

TEST_CASE("each link in one paragraph gets its own sentence, not the paragraph") {
  Graph graph("shared paragraph");
  graph.syncCell(
      "c1",
      "[[Sports]]\n\n"
      "[[Basketball]] scores by shot distance. [[Volleyball]] keeps its rotations "
      "constant. [[Baseball]] paces itself over 9 innings.");

  // Nothing sits between the node and the first sub-concept.
  CHECK(noteOf(graph, "Sports").empty());
  CHECK(subNoteOf(graph, "Sports", "Basketball") == "scores by shot distance.");
  CHECK(subNoteOf(graph, "Sports", "Volleyball") == "keeps its rotations constant.");
  CHECK(subNoteOf(graph, "Sports", "Baseball") == "paces itself over 9 innings.");
}

TEST_CASE("links on one line each own the text up to the next one") {
  Graph graph("conversation");
  graph.syncCell(
      "c1",
      "[[Greeting]] hi how are you [[Response]] good and you? "
      "[[Final Response]] Kinda tired, ready for bed.");

  CHECK(noteOf(graph, "Greeting") == "hi how are you");
  CHECK(subNoteOf(graph, "Greeting", "Response") == "good and you?");
  CHECK(subNoteOf(graph, "Greeting", "Final Response") == "Kinda tired, ready for bed.");
}

TEST_CASE("a link alone on its line owns the prose beneath it") {
  Graph graph("sections");
  graph.syncCell(
      "c1",
      "## [[Direct Versus Embedded Demand]]\n\n"
      "Demand reaches materials through two channels.\n"
      "* Concrete\n\n"
      "## [[Next Concept]]\n");

  // The heading marks of the FOLLOWING link are not swallowed into this one.
  CHECK(noteOf(graph, "Direct Versus Embedded Demand") ==
        "Demand reaches materials through two channels.\n* Concrete");
  CHECK(subNoteOf(graph, "Direct Versus Embedded Demand", "Next Concept").empty());
}

TEST_CASE("a sub-concept with nothing else on its line carries no note") {
  Graph graph("bare note");
  graph.syncCell("c1", "[[Alpha]]\n[[Beta]]\n");
  CHECK(subNoteOf(graph, "Alpha", "Beta").empty());
}

TEST_CASE("emphasis wrapping a link is trimmed, emphasis inside it is kept") {
  Graph graph("flatten");
  graph.syncCell("c1", "[[Root]] head\n- **[[Bold Concept]]** matters `a lot` here\n");
  // The "** " closing the bolded link is a separator, not description. What the
  // author wrote AFTER it survives verbatim, so the panel can write it back
  // unchanged rather than quietly stripping their markdown.
  CHECK(subNoteOf(graph, "Root", "Bold Concept") == "matters `a lot` here");
}

TEST_CASE("a piped link's note is what follows it, not its display text") {
  Graph graph("piped note");
  graph.syncCell("c1", "[[Root]] head\n- [[Binding Constraint|the constraint]] sets the pace\n");
  // The label is already the heading of the panel; repeating it as the first
  // words of its own description said the same thing twice.
  CHECK(subNoteOf(graph, "Root", "Binding Constraint") == "sets the pace");
}

TEST_CASE("one cell produces one node — the first link names it") {
  Graph graph("links");
  const LinkSyncReport report =
      graph.syncCell("c1", "The [[Binding Constraint]] shapes [[Capital Allocation]].");

  CHECK(report.createdNodeIds.size() == 1);
  CHECK(report.linkedNodeIds.size() == 1);
  CHECK(report.orphanedNodeIds.empty());
  CHECK(graph.nodeCount() == 1);
  CHECK(labelsOf(graph) == std::vector<std::string>{"Binding Constraint"});
  CHECK(cellIdsOf(graph, "Binding Constraint") == std::vector<std::string>{"c1"});

  // Later links are detail ON that node, not nodes of their own.
  CHECK(subConceptsOf(graph, "Binding Constraint") ==
        std::vector<std::string>{"Capital Allocation"});
}

TEST_CASE("sub-concepts dedup, and never repeat the node's own label") {
  Graph graph("subs");
  graph.syncCell("c1", "[[Alpha]] cites [[Beta]], [[Beta]] again, and [[Alpha]] itself.");

  CHECK(graph.nodeCount() == 1);
  CHECK(subConceptsOf(graph, "Alpha") == std::vector<std::string>{"Beta"});
}

TEST_CASE("a cell with no links produces no node") {
  Graph graph("bare");
  const LinkSyncReport report = graph.syncCell("c1", "Just prose, nothing bracketed.");
  CHECK(report.createdNodeIds.empty());
  CHECK(graph.nodeCount() == 0);
}

TEST_CASE("rewriting a cell's first link moves the node and re-homes its subs") {
  Graph graph("rehome");
  graph.syncCell("c1", "[[First]] with [[Detail]]");
  REQUIRE(graph.nodeCount() == 1);

  graph.syncCell("c1", "[[Second]] with [[Detail]]");
  CHECK(graph.nodeCount() == 1);
  CHECK(labelsOf(graph) == std::vector<std::string>{"Second"});
  CHECK(subConceptsOf(graph, "Second") == std::vector<std::string>{"Detail"});
}

TEST_CASE("syncCell is idempotent") {
  Graph graph("idempotent");
  const std::string markdown = "[[Alpha]] then [[Beta]] then [[Alpha]] again.";

  const LinkSyncReport first = graph.syncCell("c1", markdown);
  CHECK(first.createdNodeIds.size() == 1);
  CHECK(first.linkedNodeIds.size() == 1);

  const LinkSyncReport second = graph.syncCell("c1", markdown);
  CHECK(second.createdNodeIds.empty());
  CHECK(second.orphanedNodeIds.empty());
  CHECK(second.linkedNodeIds.size() == 1);
  CHECK(graph.nodeCount() == 1);

  const std::string once = graph.toJSON();
  graph.syncCell("c1", markdown);
  const nlohmann::json before = nlohmann::json::parse(once);
  const nlohmann::json after = nlohmann::json::parse(graph.toJSON());
  CHECK(before.at("nodes") == after.at("nodes"));
  CHECK(before.at("edges") == after.at("edges"));
}

TEST_CASE("syncCell ignores links inside fenced code blocks") {
  Graph graph("fences");
  const std::string markdown =
      "Real link to [[Alpha]].\n"
      "```\n"
      "code mentioning [[NotALink]]\n"
      "```\n"
      "~~~python\n"
      "print('[[AlsoNotALink]]')\n"
      "~~~\n"
      "Another real link to [[Beta]].\n";

  const LinkSyncReport report = graph.syncCell("c1", markdown);
  // Alpha names the cell; Beta is a sub-concept. Neither fenced link counts.
  CHECK(report.createdNodeIds.size() == 1);
  CHECK(labelsOf(graph) == std::vector<std::string>{"Alpha"});
  CHECK(subConceptsOf(graph, "Alpha") == std::vector<std::string>{"Beta"});
}

TEST_CASE("syncCell survives malformed bracket sequences") {
  Graph graph("malformed");
  const LinkSyncReport report = graph.syncCell(
      "c1", "unclosed [[Dangling and empty [[]] and [[  ]] and [[!!]]\n[[Good]]");

  // "!!" normalizes to a usable key, "  " and "" do not. It comes first, so
  // it names the cell and "Good" becomes its sub-concept.
  CHECK(graph.nodeCount() == 1);
  CHECK(labelsOf(graph) == std::vector<std::string>{"!!"});
  CHECK(report.createdNodeIds.size() == 1);
  CHECK(subConceptsOf(graph, "!!") == std::vector<std::string>{"Good"});
}

TEST_CASE("an embedded file is not a concept") {
  Graph graph("embeds");
  graph.syncCell("c1", "[[Turbine Efficiency]] rises with inlet temperature.\n\n![[curve.png]]\n");

  // Without this, every image an author dropped into a cell became a node
  // named after its filename.
  CHECK(labelsOf(graph) == std::vector<std::string>{"Turbine Efficiency"});
  CHECK(subConceptsOf(graph, "Turbine Efficiency").empty());
}

TEST_CASE("an embed mid-sentence does not break the link around it") {
  Graph graph("embeds inline");
  graph.syncCell("c1", "[[Alpha]] see ![[chart.png]] then [[Beta]] follows.");

  CHECK(labelsOf(graph) == std::vector<std::string>{"Alpha"});
  CHECK(subConceptsOf(graph, "Alpha") == std::vector<std::string>{"Beta"});
}

TEST_CASE("syncCell takes the innermost link when brackets nest") {
  Graph graph("nested");
  graph.syncCell("c1", "[[Outer [[Inner]]]] tail");
  CHECK(labelsOf(graph) == std::vector<std::string>{"Inner"});
}

TEST_CASE("syncCell reads the target side of a piped link") {
  Graph graph("piped");
  graph.syncCell("c1", "See [[Binding Constraint|the constraint]] here.");
  CHECK(labelsOf(graph) == std::vector<std::string>{"Binding Constraint"});
}

TEST_CASE("syncCell collects a node the cell stops mentioning") {
  Graph graph("orphans");
  // Two cells, so there are two nodes to orphan between.
  graph.syncCell("c1", "[[Alpha]]");
  graph.syncCell("c2", "[[Beta]]");
  REQUIRE(graph.nodeCount() == 2);
  const LinkSyncReport report = graph.syncCell("c2", "");

  CHECK(report.createdNodeIds.empty());
  // c2 now links nothing, so it names no node.
  CHECK(report.linkedNodeIds.empty());
  REQUIRE(report.orphanedNodeIds.size() == 1);

  // An unreferenced node is DELETED, not merely unlinked. Keeping it was the
  // cause of a real reported bug: because the editor debounces, typing
  // "[[Accounting]]" syncs "[[A]]", "[[Acc]]", "[[Accou]]"... and every
  // abandoned prefix stayed in the graph forever.
  //
  // The old intent — "the author may still want it" — is preserved by
  // collectOrphans() sparing any node the author actually invested in:
  // pinned, coloured, annotated, edge-connected, or cited by another cell.
  CHECK(graph.nodeCount() == 1);
  CHECK(labelsOf(graph) == std::vector<std::string>{"Alpha"});
}

TEST_CASE("a node referenced by two cells is orphaned only by the last one") {
  Graph graph("shared");
  graph.syncCell("c1", "[[Shared]]");
  graph.syncCell("c2", "[[Shared]]");
  CHECK(cellIdsOf(graph, "Shared").size() == 2);

  CHECK(graph.syncCell("c1", "nothing here").orphanedNodeIds.empty());
  CHECK(cellIdsOf(graph, "Shared") == std::vector<std::string>{"c2"});
  CHECK(graph.syncCell("c2", "nothing here").orphanedNodeIds.size() == 1);
}

TEST_CASE("removeCell drops the node the cell named") {
  Graph graph("remove cell");
  graph.syncCell("c1", "[[Alpha]] and [[Beta]]");  // Alpha is the node, Beta a sub
  graph.syncCell("c2", "[[Beta]]");                // Beta is c2's own node
  REQUIRE(graph.nodeCount() == 2);

  const LinkSyncReport report = graph.removeCell("c1");
  CHECK(report.orphanedNodeIds.size() == 1);  // Alpha only; Beta belongs to c2
  CHECK(cellIdsOf(graph, "Beta") == std::vector<std::string>{"c2"});
  CHECK(nlohmann::json::parse(graph.toJSON()).at("cells").size() == 1);
}

TEST_CASE("cells keep contiguous 0-based order") {
  Graph graph("cell order");
  graph.syncCell("c1", "one");
  graph.syncCell("c2", "two");
  graph.syncCell("c3", "three");
  graph.removeCell("c2");

  const nlohmann::json cells = nlohmann::json::parse(graph.toJSON()).at("cells");
  REQUIRE(cells.size() == 2);
  std::vector<int> orders;
  for (const nlohmann::json& cell : cells) {
    orders.push_back(cell.at("order").get<int>());
  }
  std::sort(orders.begin(), orders.end());
  CHECK(orders == std::vector<int>{0, 1});
}

TEST_CASE("syncCell rejects an empty cell id") {
  Graph graph("cell id");
  CHECK_THROWS_AS(graph.syncCell("", "[[Alpha]]"), GraphError);
  CHECK_THROWS_AS(graph.removeCell(""), GraphError);
}

TEST_CASE("search ranks exact label matches above partial ones") {
  Graph graph("search");
  graph.addNode("Binding Constraint", NodeKind::Concept);
  graph.addNode("Capital Allocation", NodeKind::Concept);
  graph.addNode("Constraint Theory", NodeKind::Concept);

  const std::vector<SearchHit> hits = graph.search("binding constraint");
  REQUIRE(hits.size() >= 2);
  CHECK(hits[0].label == "Binding Constraint");
  CHECK(hits[0].score == doctest::Approx(1.0));
  CHECK(hits[1].score < hits[0].score);
  for (const SearchHit& hit : hits) {
    CHECK(hit.score > 0.0);
    CHECK(hit.score <= 1.0);
  }
}

TEST_CASE("search matches by prefix and honours the limit") {
  Graph graph("search limits");
  graph.addNode("Capital Allocation", NodeKind::Concept);
  graph.addNode("Capitalization Rate", NodeKind::Metric);
  graph.addNode("Unrelated", NodeKind::Concept);

  CHECK(graph.search("capit").size() == 2);
  CHECK(graph.search("capit", 1).size() == 1);
  CHECK(graph.search("capit", 0).empty());
  CHECK(graph.search("").empty());
  CHECK(graph.search("zzzz").empty());
}

TEST_CASE("search reflects removals") {
  Graph graph("search refresh");
  const std::string id = graph.addNode("Alpha", NodeKind::Concept);
  CHECK(graph.search("alpha").size() == 1);
  graph.removeNode(id);
  CHECK(graph.search("alpha").empty());
}

TEST_CASE("backlinks lists the nodes pointing at a node") {
  Graph graph("backlinks");
  const std::string a = graph.addNode("Alpha", NodeKind::Concept);
  const std::string b = graph.addNode("Beta", NodeKind::Concept);
  const std::string c = graph.addNode("Gamma", NodeKind::Concept);
  graph.addEdge(a, c, RelationKind::Supports);
  graph.addEdge(b, c, RelationKind::Causes);
  graph.addEdge(c, a, RelationKind::DependsOn);

  std::vector<std::string> expected{a, b};
  std::sort(expected.begin(), expected.end());
  CHECK(graph.backlinks(c) == expected);
  CHECK(graph.backlinks(b).empty());
  CHECK(graph.backlinks(a) == std::vector<std::string>{c});
  CHECK_THROWS_AS(graph.backlinks("n999"), GraphError);
}

TEST_CASE("an undirected association backlinks both ways") {
  Graph graph("undirected backlinks");
  const std::string a = graph.addNode("Alpha", NodeKind::Concept);
  const std::string b = graph.addNode("Beta", NodeKind::Concept);
  graph.addEdge(a, b, RelationKind::RelatesTo);

  CHECK(graph.backlinks(a) == std::vector<std::string>{b});
  CHECK(graph.backlinks(b) == std::vector<std::string>{a});
}

// ---------------------------------------------------------------------------
// Orphan collection — regression tests for the bug where typing a link left a
// node behind for every intermediate keystroke state.
// ---------------------------------------------------------------------------

TEST_CASE("typing a link does not accumulate a node per keystroke") {
  Graph g("typing");
  // Exactly what a debounced editor sends while the author types "Accounting".
  g.syncCell("c1", "[[A]]");
  g.syncCell("c1", "[[Acc]]");
  g.syncCell("c1", "[[Accou]]");
  g.syncCell("c1", "[[Accounting]]");

  CHECK(g.nodeCount() == 1);
  const std::vector<std::string> order = g.nodeOrder();
  REQUIRE(order.size() == 1);
  CHECK(g.search("Accounting", 5).size() == 1);
}

TEST_CASE("correcting a typo does not strand the misspelling") {
  Graph g("typo");
  g.syncCell("c1", "[[Accsdounting]]");
  CHECK(g.nodeCount() == 1);
  g.syncCell("c1", "[[Accounting]]");
  CHECK(g.nodeCount() == 1);
  const auto hits = g.search("Accsdounting", 5);
  CHECK(hits.empty());
}

TEST_CASE("a concept lives exactly as long as a cell mentions it") {
  SUBCASE("another cell still citing it keeps it alive") {
    Graph g("shared");
    g.syncCell("c1", "[[Shared]]");
    g.syncCell("c2", "[[Shared]]");
    g.syncCell("c1", "");  // c1 drops it, c2 still asserts it
    CHECK(g.nodeCount() == 1);
  }

  SUBCASE("a drawn edge does NOT keep an unmentioned concept alive") {
    // Reported bug: deleting "[[introduction]]" left the concept on the canvas
    // because an edge had been drawn from it, with nothing explaining why.
    Graph g("edged");
    g.syncCell("c1", "[[hi]]");
    g.syncCell("c2", "[[introduction]]");
    const std::string hi = g.addNode("hi", NodeKind::Concept);
    const std::string intro = g.addNode("introduction", NodeKind::Concept);
    g.addEdge(intro, hi, RelationKind::Causes);
    REQUIRE(g.edgeCount() == 1);

    g.syncCell("c2", "");  // the author deletes the mention

    CHECK(g.nodeCount() == 1);
    CHECK(labelsOf(g) == std::vector<std::string>{"hi"});
    // The edge went with it: an edge to a concept that no longer exists
    // asserts nothing.
    CHECK(g.edgeCount() == 0);
  }

  SUBCASE("a pin does not outlive the text either") {
    Graph g("pinned");
    g.syncCell("c1", "[[Pinned]]");
    const std::vector<std::string> ids = g.nodeOrder();
    REQUIRE(ids.size() == 1);
    g.pinNode(ids[0], 10.0, 20.0);
    g.syncCell("c1", "");
    CHECK(g.nodeCount() == 0);
  }
}

TEST_CASE("removing a cell collects its exclusive orphans") {
  Graph g("drop");
  g.syncCell("c1", "[[Only Here]]");
  CHECK(g.nodeCount() == 1);
  g.removeCell("c1");
  CHECK(g.nodeCount() == 0);
}
