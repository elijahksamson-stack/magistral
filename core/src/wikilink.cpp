// [[wikilink]] parser. Line-oriented so a fenced code block can be skipped
// wholesale and an unclosed "[[" can never swallow the rest of the document.

#include "wikilink.hpp"

#include <braindump/braindump.hpp>

#include <string>
#include <unordered_set>
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

/** The link target: text before the first '|', trimmed. Empty when absent. */
std::string linkTarget(const std::string& body) {
  const std::size_t pipe = body.find('|');
  return trim(pipe == std::string::npos ? body : body.substr(0, pipe));
}

/** Strip list bullets, heading marks and emphasis so a note reads as prose. */
std::string flattenLine(const std::string& line, const std::string& label) {
  std::string out;
  out.reserve(line.size());

  // Replace [[Label]] / [[Label|display]] with the text a reader would see.
  std::size_t i = 0;
  while (i < line.size()) {
    if (i + 1 < line.size() && line[i] == '[' && line[i + 1] == '[') {
      const std::size_t close = line.find("]]", i + 2);
      if (close != std::string::npos) {
        const std::string body = line.substr(i + 2, close - (i + 2));
        const std::size_t pipe = body.find('|');
        out += trim(pipe == std::string::npos ? body : body.substr(pipe + 1));
        i = close + 2;
        continue;
      }
    }
    if (line[i] == '*' || line[i] == '_' || line[i] == '`' || line[i] == '#') {
      ++i;  // emphasis and heading marks carry no meaning in a note
      continue;
    }
    out += line[i];
    ++i;
  }

  std::string text = trim(out);

  // Drop a leading list marker.
  std::size_t cut = 0;
  while (cut < text.size() && (text[cut] == '-' || text[cut] == '+' || text[cut] == '>' ||
                               isAsciiSpace(text[cut]))) {
    ++cut;
  }
  text = trim(text.substr(cut));

  // A line that opens by naming the concept is describing it; the name is
  // already the label, so keep only what it goes on to say.
  const std::string trimmedLabel = trim(label);
  if (text.size() >= trimmedLabel.size() &&
      normalizeLabel(text.substr(0, trimmedLabel.size())) == normalizeLabel(trimmedLabel)) {
    std::string rest = text.substr(trimmedLabel.size());
    std::size_t lead = 0;
    while (lead < rest.size() && (isAsciiSpace(rest[lead]) || rest[lead] == '-' ||
                                  rest[lead] == ':' || rest[lead] == ',')) {
      ++lead;
    }
    // A line that is ONLY the link says nothing about it. Returning the label
    // as its own note would fill every export with "Beta": "Beta".
    return trim(rest.substr(lead));
  }
  return text;
}

void scanLineHits(const std::string& line, std::vector<WikiLinkHit>& hits,
                  std::unordered_set<std::string>& seen) {
  std::size_t openAt = std::string::npos;
  std::size_t i = 0;
  while (i + 1 < line.size()) {
    if (line[i] == '[' && line[i + 1] == '[') {
      openAt = i + 2;
      i += 2;
      continue;
    }
    if (line[i] == ']' && line[i + 1] == ']') {
      if (openAt != std::string::npos) {
        const std::string label = linkTarget(line.substr(openAt, i - openAt));
        const std::string key = normalizeLabel(label);
        if (!label.empty() && !key.empty() && seen.insert(key).second) {
          hits.push_back(WikiLinkHit{label, flattenLine(line, label)});
        }
        openAt = std::string::npos;
      }
      i += 2;
      continue;
    }
    ++i;
  }
}

void scanLine(const std::string& line, std::vector<std::string>& labels,
              std::unordered_set<std::string>& seen) {
  std::size_t openAt = std::string::npos;
  std::size_t i = 0;
  while (i + 1 < line.size()) {
    if (line[i] == '[' && line[i + 1] == '[') {
      // A second "[[" before any "]]" means the inner link is the real one.
      openAt = i + 2;
      i += 2;
      continue;
    }
    if (line[i] == ']' && line[i + 1] == ']') {
      if (openAt != std::string::npos) {
        const std::string label = linkTarget(line.substr(openAt, i - openAt));
        const std::string key = normalizeLabel(label);
        if (!label.empty() && !key.empty() && seen.insert(key).second) {
          labels.push_back(label);
        }
        openAt = std::string::npos;
      }
      i += 2;
      continue;
    }
    ++i;
  }
}

}  // namespace

std::vector<WikiLinkHit> parseWikiLinkHits(const std::string& markdown) {
  std::vector<WikiLinkHit> hits;
  std::unordered_set<std::string> seen;

  bool isInsideFence = false;
  char fenceChar = '\0';
  std::size_t fenceLength = 0;

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
      } else if (candidateChar == fenceChar && candidateLength >= fenceLength) {
        isInsideFence = false;
      }
    } else if (!isInsideFence) {
      scanLineHits(line, hits, seen);
    }

    if (isLastLine) {
      break;
    }
    lineStart = lineEnd + 1;
  }

  return hits;
}

std::vector<std::string> parseWikiLinks(const std::string& markdown) {
  std::vector<std::string> labels;
  std::unordered_set<std::string> seen;

  bool isInsideFence = false;
  char fenceChar = '\0';
  std::size_t fenceLength = 0;

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
      } else if (candidateChar == fenceChar && candidateLength >= fenceLength) {
        isInsideFence = false;
      }
    } else if (!isInsideFence) {
      scanLine(line, labels, seen);
    }

    if (isLastLine) {
      break;
    }
    lineStart = lineEnd + 1;
  }

  return labels;
}

}  // namespace internal
}  // namespace braindump
