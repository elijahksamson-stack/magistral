// [[wikilink]] parser.
//
// A link owns the text from the end of its own "]]" until the start of the next
// link, or the end of the cell. The first link in a cell names the node and its
// span describes it; every later link is a sub-concept described by its own
// span. Line boundaries do not divide a span, so a link alone on a line owns the
// prose beneath it — the section case falls out of the general rule rather than
// needing one of its own.
//
// This replaced a line-oriented reading in which a note was the WHOLE line its
// link sat on. A soft-wrapped paragraph is one line, so three links in one
// paragraph all reported the same paragraph as their description.

#include "wikilink.hpp"

#include <braindump/braindump.hpp>

#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace braindump {
namespace internal {
namespace {

constexpr std::size_t kMinFenceLength = 3;
constexpr std::size_t kMaxFenceIndent = 3;

bool isAsciiSpace(char ch) noexcept {
  return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\v' ||
         ch == '\f';
}

std::string trim(const std::string& text) {
  std::size_t begin = 0;
  std::size_t end = text.size();
  while (begin < end && isAsciiSpace(text[begin])) {
    ++begin;
  }
  while (end > begin && isAsciiSpace(text[end - 1])) {
    --end;
  }
  return text.substr(begin, end - begin);
}

/**
 * What may sit between a link and the description it introduces.
 *
 * Covers "[[X]] — foo", "[[X]]: foo" and the emphasis wrapping a bolded link in
 * "- **[[X]]** foo". Trimmed from the FRONT only: the same characters inside the
 * description are the author's own markdown and are left alone.
 */
bool isLeadingSeparator(char ch) noexcept {
  return isAsciiSpace(ch) || ch == '-' || ch == ':' || ch == ',' || ch == '|' ||
         ch == '>' || ch == '*' || ch == '_' || ch == '`';
}

/** A CommonMark code fence: up to 3 spaces of indent, then 3+ ` or ~. */
bool readFence(const std::string& line, char& fenceChar, std::size_t& fenceLength) {
  std::size_t i = 0;
  while (i < line.size() && line[i] == ' ' && i < kMaxFenceIndent) {
    ++i;
  }
  if (i >= line.size() || (line[i] != '`' && line[i] != '~')) {
    return false;
  }
  const char candidate = line[i];
  std::size_t run = 0;
  while (i + run < line.size() && line[i + run] == candidate) {
    ++run;
  }
  if (run < kMinFenceLength) {
    return false;
  }
  fenceChar = candidate;
  fenceLength = run;
  return true;
}

using ByteRange = std::pair<std::size_t, std::size_t>;

/**
 * Byte ranges covered by fenced code blocks, including their fence lines.
 *
 * Spans cross line boundaries, so fences can no longer be skipped by simply not
 * scanning a line. They are located once here, then excluded both from the link
 * scan and from the text of any span that runs across them.
 */
std::vector<ByteRange> fencedRegions(const std::string& markdown) {
  std::vector<ByteRange> regions;

  bool isInsideFence = false;
  char fenceChar = '\0';
  std::size_t fenceLength = 0;
  std::size_t regionStart = 0;

  std::size_t lineStart = 0;
  while (lineStart <= markdown.size()) {
    std::size_t lineEnd = markdown.find('\n', lineStart);
    const bool isLastLine = lineEnd == std::string::npos;
    if (isLastLine) {
      lineEnd = markdown.size();
    }
    const std::string line = markdown.substr(lineStart, lineEnd - lineStart);

    char candidateChar = '\0';
    std::size_t candidateLength = 0;
    if (readFence(line, candidateChar, candidateLength)) {
      if (!isInsideFence) {
        isInsideFence = true;
        fenceChar = candidateChar;
        fenceLength = candidateLength;
        regionStart = lineStart;
      } else if (candidateChar == fenceChar && candidateLength >= fenceLength) {
        isInsideFence = false;
        regions.emplace_back(regionStart, isLastLine ? lineEnd : lineEnd + 1);
      }
    }

    if (isLastLine) {
      break;
    }
    lineStart = lineEnd + 1;
  }

  // An unclosed fence runs to the end of the cell, which is how a markdown
  // renderer reads it too.
  if (isInsideFence) {
    regions.emplace_back(regionStart, markdown.size());
  }
  return regions;
}

/** Index of the region containing `position`, or regions.size() when none does. */
std::size_t regionAt(const std::vector<ByteRange>& regions, std::size_t position) {
  for (std::size_t i = 0; i < regions.size(); ++i) {
    if (position >= regions[i].first && position < regions[i].second) {
      return i;
    }
  }
  return regions.size();
}

/** The link target: text before the first '|', trimmed. Empty when absent. */
std::string linkTarget(const std::string& body) {
  const std::size_t pipe = body.find('|');
  return trim(pipe == std::string::npos ? body : body.substr(0, pipe));
}

struct LinkMatch {
  std::string label;
  /** Offset of the opening '['. */
  std::size_t linkStart;
  /** Offset one past the closing ']]'. */
  std::size_t linkEnd;
};

/**
 * Every link in the document, in order, skipping fenced code.
 *
 * A second "[[" before any "]]" means the inner link is the real one, which is
 * what makes "[[Outer [[Inner]]]]" resolve to Inner. A candidate body spanning a
 * newline is rejected: a label is a single line, and without that rule one
 * unclosed "[[" would swallow the rest of the cell as a label.
 */
std::vector<LinkMatch> scanLinks(const std::string& markdown,
                                 const std::vector<ByteRange>& regions) {
  std::vector<LinkMatch> matches;

  std::size_t openAt = std::string::npos;
  std::size_t openedFrom = std::string::npos;
  bool openIsEmbed = false;
  std::size_t i = 0;
  while (i + 1 < markdown.size()) {
    const std::size_t region = regionAt(regions, i);
    if (region != regions.size()) {
      i = regions[region].second;
      openAt = std::string::npos;
      openedFrom = std::string::npos;
      openIsEmbed = false;
      continue;
    }

    if (markdown[i] == '[' && markdown[i + 1] == '[') {
      openedFrom = i;
      openAt = i + 2;
      // `![[file.png]]` embeds a file; it does not assert a concept. Without
      // this every image an author drops into a cell became a node named after
      // its filename, and the map filled with "diagram.png".
      openIsEmbed = i > 0 && markdown[i - 1] == '!';
      i += 2;
      continue;
    }
    if (markdown[i] == ']' && markdown[i + 1] == ']') {
      if (openAt != std::string::npos) {
        const std::string body = markdown.substr(openAt, i - openAt);
        if (!openIsEmbed && body.find('\n') == std::string::npos) {
          const std::string label = linkTarget(body);
          if (!label.empty() && !normalizeLabel(label).empty()) {
            matches.push_back(LinkMatch{label, openedFrom, i + 2});
          }
        }
        openAt = std::string::npos;
        openedFrom = std::string::npos;
        openIsEmbed = false;
      }
      i += 2;
      continue;
    }
    ++i;
  }

  return matches;
}

/**
 * The description a link owns: the text in [from, to), trimmed at both ends.
 *
 * When the next link begins on a LATER line, the text on that link's own line
 * ahead of it belongs to that line rather than to this description — a list
 * marker, a "## " heading mark, or the opening clause of a sentence the next
 * link completes. Keeping it would end this description with a stranded
 * fragment, so the trailing partial line is dropped. Within a single line
 * nothing is dropped, so "[[A]] one [[B]] two" reads exactly as written.
 *
 * A fenced code block INSIDE a span stays in the text. Fences are skipped when
 * hunting for links, so code can never mint a phantom concept — but excising it
 * here would make the description lossy, and the panel writes what it reads
 * straight back to the cell. That would delete the author's code block on their
 * first description edit.
 */
std::string spanText(const std::string& markdown, std::size_t from, std::size_t to,
                     bool hasNextLink) {
  if (to <= from) {
    return {};
  }

  std::size_t end = to;
  if (hasNextLink) {
    const std::size_t lastNewline = markdown.rfind('\n', to - 1);
    if (lastNewline != std::string::npos && lastNewline >= from) {
      end = lastNewline;
    }
  }

  const std::string text = markdown.substr(from, end - from);
  std::size_t begin = 0;
  while (begin < text.size() && isLeadingSeparator(text[begin])) {
    ++begin;
  }
  return trim(text.substr(begin));
}

}  // namespace

std::vector<WikiLinkHit> parseWikiLinkHits(const std::string& markdown) {
  const std::vector<ByteRange> regions = fencedRegions(markdown);
  const std::vector<LinkMatch> matches = scanLinks(markdown, regions);

  std::vector<WikiLinkHit> hits;
  std::unordered_set<std::string> seen;
  for (std::size_t i = 0; i < matches.size(); ++i) {
    const std::string key = normalizeLabel(matches[i].label);
    if (!seen.insert(key).second) {
      continue;
    }
    const bool hasNext = i + 1 < matches.size();
    const std::size_t to = hasNext ? matches[i + 1].linkStart : markdown.size();
    hits.push_back(WikiLinkHit{matches[i].label,
                               spanText(markdown, matches[i].linkEnd, to, hasNext)});
  }
  return hits;
}

std::vector<std::string> parseWikiLinks(const std::string& markdown) {
  const std::vector<ByteRange> regions = fencedRegions(markdown);

  std::vector<std::string> labels;
  std::unordered_set<std::string> seen;
  for (const LinkMatch& match : scanLinks(markdown, regions)) {
    if (seen.insert(normalizeLabel(match.label)).second) {
      labels.push_back(match.label);
    }
  }
  return labels;
}

}  // namespace internal
}  // namespace braindump
