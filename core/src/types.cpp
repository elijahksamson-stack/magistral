// Enumeration wire names and normalizeLabel — the dedup key for the whole app.

#include <braindump/braindump.hpp>

#include <array>
#include <cstddef>
#include <string>

namespace braindump {
namespace {

// Ordinals MUST match NODE_KINDS / RELATION_KINDS in shared/types/graph.ts.
constexpr std::array<const char*, 7> kNodeKindNames = {
    "concept", "entity", "claim", "question", "source", "metric", "group",
};

constexpr std::array<const char*, 10> kRelationKindNames = {
    "relates_to", "causes",      "part_of",     "contradicts", "supports",
    "depends_on", "instance_of", "mentions",    "affects",     "affected_by",
};

bool isAsciiSpace(unsigned char ch) noexcept {
  return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\v' ||
         ch == '\f';
}

/** ASCII punctuation only — bytes >= 0x80 pass through untouched. */
bool isAsciiPunct(unsigned char ch) noexcept {
  return (ch >= '!' && ch <= '/') || (ch >= ':' && ch <= '@') ||
         (ch >= '[' && ch <= '`') || (ch >= '{' && ch <= '~');
}

char toLowerAscii(unsigned char ch) noexcept {
  if (ch >= 'A' && ch <= 'Z') {
    return static_cast<char>(ch - 'A' + 'a');
  }
  return static_cast<char>(ch);
}

/** Trimmed, whitespace-collapsed, ASCII-lowercased. Non-ASCII bytes preserved. */
std::string collapseAndLower(const std::string& label) {
  std::string out;
  out.reserve(label.size());
  bool hasPendingSpace = false;
  for (const char raw : label) {
    const unsigned char ch = static_cast<unsigned char>(raw);
    if (isAsciiSpace(ch)) {
      hasPendingSpace = !out.empty();
      continue;
    }
    if (hasPendingSpace) {
      out.push_back(' ');
      hasPendingSpace = false;
    }
    out.push_back(toLowerAscii(ch));
  }
  return out;
}

}  // namespace

const char* toString(NodeKind kind) noexcept {
  const auto index = static_cast<std::size_t>(kind);
  if (index >= kNodeKindNames.size()) {
    return kNodeKindNames[0];
  }
  return kNodeKindNames[index];
}

const char* toString(RelationKind relation) noexcept {
  const auto index = static_cast<std::size_t>(relation);
  if (index >= kRelationKindNames.size()) {
    return kRelationKindNames[0];
  }
  return kRelationKindNames[index];
}

NodeKind nodeKindFromString(const std::string& s) {
  for (std::size_t i = 0; i < kNodeKindNames.size(); ++i) {
    if (s == kNodeKindNames[i]) {
      return static_cast<NodeKind>(i);
    }
  }
  throw std::invalid_argument("unknown NodeKind: '" + s + "'");
}

RelationKind relationKindFromString(const std::string& s) {
  for (std::size_t i = 0; i < kRelationKindNames.size(); ++i) {
    if (s == kRelationKindNames[i]) {
      return static_cast<RelationKind>(i);
    }
  }
  throw std::invalid_argument("unknown RelationKind: '" + s + "'");
}

std::string normalizeLabel(const std::string& label) noexcept {
  const std::string collapsed = collapseAndLower(label);

  std::size_t begin = 0;
  std::size_t end = collapsed.size();
  const auto isStrippable = [&collapsed](std::size_t i) {
    const unsigned char ch = static_cast<unsigned char>(collapsed[i]);
    return isAsciiSpace(ch) || isAsciiPunct(ch);
  };
  while (begin < end && isStrippable(begin)) {
    ++begin;
  }
  while (end > begin && isStrippable(end - 1)) {
    --end;
  }
  if (begin == 0 && end == collapsed.size()) {
    return collapsed;
  }

  // A label made entirely of punctuation keeps its collapsed form rather than
  // normalizing to "" — an empty dedup key would collide with every other one.
  std::string stripped = collapsed.substr(begin, end - begin);
  if (stripped.empty()) {
    return collapsed;
  }
  return stripped;
}

namespace internal {

bool isDirectedRelation(RelationKind relation) noexcept {
  return relation != RelationKind::RelatesTo;
}

std::string edgeTripleKey(const std::string& sourceId,
                          const std::string& targetId,
                          RelationKind relation) {
  const bool isDirected = isDirectedRelation(relation);
  const bool shouldSwap = !isDirected && targetId < sourceId;
  const std::string& first = shouldSwap ? targetId : sourceId;
  const std::string& second = shouldSwap ? sourceId : targetId;
  std::string key;
  key.reserve(first.size() + second.size() + 4);
  key.append(first).push_back('\x1f');
  key.append(second).push_back('\x1f');
  key.push_back(static_cast<char>('0' + static_cast<int>(relation)));
  return key;
}

std::vector<std::string> tokenize(const std::string& normalized) {
  std::vector<std::string> terms;
  std::string current;
  const auto flush = [&terms, &current]() {
    if (!current.empty()) {
      terms.push_back(current);
      current.clear();
    }
  };
  for (const char raw : normalized) {
    const unsigned char ch = static_cast<unsigned char>(raw);
    const bool isTermByte = (ch >= 'a' && ch <= 'z') ||
                            (ch >= '0' && ch <= '9') || ch >= 0x80;
    if (isTermByte) {
      current.push_back(raw);
      continue;
    }
    flush();
  }
  flush();
  return terms;
}

}  // namespace internal
}  // namespace braindump
