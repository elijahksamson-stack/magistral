// PRIVATE. [[wikilink]] extraction — the only automatic node-creation trigger.

#ifndef BRAINDUMP_SRC_WIKILINK_HPP
#define BRAINDUMP_SRC_WIKILINK_HPP

#include <string>
#include <vector>

namespace braindump {
namespace internal {

/**
 * Labels of every [[wikilink]] in `markdown`, in first-occurrence order and
 * deduplicated by normalizeLabel.
 *
 * Handles [[Label]] and [[Label|display text]]. Links inside fenced code
 * blocks are ignored — code is not a link. An unclosed "[[" and an empty
 * "[[]]" yield nothing. When brackets nest, the innermost link wins.
 */
std::vector<std::string> parseWikiLinks(const std::string& markdown);

/** A link plus the prose it sat in. */
struct WikiLinkHit {
  std::string label;
  /**
   * The line the link appeared on, with markdown decoration and link syntax
   * flattened, and the label itself removed from the front when the line opens
   * with it. Empty when the line said nothing beyond the link.
   */
  std::string note;
};

/**
 * Same rules as parseWikiLinks, but each hit carries the line it came from.
 *
 * That line IS the note: an author writing "- [[heat rate]] (MMBtu of fuel per
 * MWh) defines a gas plant's cost structure" has already said what the concept
 * means, and throwing that away leaves an export full of bare labels.
 */
std::vector<WikiLinkHit> parseWikiLinkHits(const std::string& markdown);

}  // namespace internal
}  // namespace braindump

#endif  // BRAINDUMP_SRC_WIKILINK_HPP
