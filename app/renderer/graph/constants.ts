/**
 * Tunables for the graph pane. Every magic number in the renderer, the
 * interaction layer and the exporters lives here.
 */

import type { RelationKind } from '../../../shared/types/graph';

// -- viewport ---------------------------------------------------------------

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;
/** Multiplier applied by the +/- buttons and keys. */
export const ZOOM_STEP = 1.25;
/** Wheel delta -> zoom exponent. Tuned for trackpads. */
export const WHEEL_ZOOM_SENSITIVITY = 0.0016;
/** Screen-space breathing room left around the graph when framing it. */
export const FIT_PADDING_PX = 72;
/** Below this, a fit is meaningless — used to guard degenerate bounds. */
export const EPSILON = 1e-6;

// -- nodes ------------------------------------------------------------------

/** World-space radius of a node with no authored body content. */
export const MIN_NODE_RADIUS = 4;
/** Firm cap: content-rich nodes should read heavier, never dominate the map. */
export const MAX_NODE_RADIUS = 11;
/** Clamps so nodes stay visible when zoomed out and sane when zoomed in. */
export const MIN_SCREEN_NODE_RADIUS = 2;
export const MAX_SCREEN_NODE_RADIUS = 28;
/** Extra screen pixels around a node that still count as a hit. */
export const NODE_HIT_SLOP_PX = 6;
/** Pointer travel below this on pointerup still counts as a click. */
export const CLICK_SLOP_PX = 4;

export const NODE_STROKE_COLOR = '#090a0b';
export const NODE_STROKE_WIDTH = 1;
/** Nodes are neutral at rest; category lives in the thin outer ring. */
export const NODE_CORE_COLOR = '#aeb6b5';
export const NODE_CATEGORY_RING_WIDTH = 1.55;
export const HOVER_RING_COLOR = '#45c6d4';
export const HOVER_RING_WIDTH = 1.4;
export const HOVER_RING_GAP = 4;
export const HOVER_HALO_COLOR = 'rgba(69, 198, 212, 0.11)';
export const SELECTED_RING_COLOR = '#83dde5';
export const SELECTED_RING_WIDTH = 2;
export const SELECTED_RING_GAP = 3.5;
export const PINNED_RING_COLOR = '#f0b46a';
export const PINNED_RING_WIDTH = 1.25;

// -- edges ------------------------------------------------------------------

/** Perpendicular bow of the quadratic control point, as a fraction of length. */
export const EDGE_BOW_RATIO = 0.13;
export const MIN_EDGE_WIDTH = 0.55;
export const MAX_EDGE_WIDTH = 2.75;
/** Edge weight that maps to MAX_EDGE_WIDTH. */
export const EDGE_WEIGHT_CEILING = 6;
export const EDGE_COLOR = '#263437';
export const EDGE_HIGHLIGHT_COLOR = '#45c6d4';

/**
 * A colour per relation kind, so the canvas says what the Filters panel does.
 *
 * Typed as an exhaustive Record: adding a RelationKind fails the build here
 * rather than silently drawing the new relation in whatever the fallback was.
 *
 * Two constraints shaped the palette. Cyan and lime are reserved — selection
 * and AI findings already mean those colours, and a relation wearing one would
 * read as state rather than as type. And `relates_to` and `mentions` stay muted
 * deliberately: they are the untyped defaults most edges carry, so making them
 * loud would drown out the relations the author chose on purpose.
 */
export const RELATION_COLORS: Record<RelationKind, string> = {
  relates_to: '#33474b',
  mentions: '#3d4c50',
  causes: '#d9734e',
  affects: '#c98a5e',
  affected_by: '#8f7f9c',
  depends_on: '#c2a24a',
  part_of: '#6f86c4',
  instance_of: '#8f74b5',
  supports: '#5aa36f',
  contradicts: '#c2495c',
};
export const EDGE_ALPHA = 0.58;
export const EDGE_HIGHLIGHT_ALPHA = 0.9;
export const DIMMED_ALPHA = 0.12;

// -- labels -----------------------------------------------------------------

/*
 * Semantic zoom. The map is mostly text, so naming everything at every scale is
 * what made it read as a graph-library dump rather than a composed map. Zoomed
 * out the author wants the shape of the territory and its few landmarks; zoomed
 * in they want the detail. Zoom therefore decides HOW MUCH is named, and
 * PageRank centrality — normalised so the peak node is 1 — decides which.
 */
/** At or above this zoom, significant concepts are named. Below it, only landmarks. */
export const LABEL_ZOOM_MEDIUM = 0.45;
/** At or above this zoom, every concept on screen is named. */
export const LABEL_ZOOM_CLOSE = 0.95;

/** Centrality a concept must reach to be named while zoomed out to the whole map. */
export const LABEL_CENTRALITY_FAR = 0.62;
/** Centrality a concept must reach to be named at the middle tier. */
export const LABEL_CENTRALITY_MEDIUM = 0.18;
export const LABEL_FONT_SIZE_PX = 13;
export const LABEL_FONT_FAMILY =
  '"Avenir Next", Avenir, Inter, "Helvetica Neue", "Segoe UI", sans-serif';
export const LABEL_FONT = `${LABEL_FONT_SIZE_PX}px ${LABEL_FONT_FAMILY}`;
/** Gap between the bottom of a node and the top of its label. */
export const LABEL_OFFSET_PX = 5;
/** Hard cap on labels considered per frame, highest centrality first. */
export const MAX_LABEL_CANDIDATES = 400;
/** Collision boxes are inflated by this much before overlap testing. */
export const LABEL_GAP_PX = 3;
/** Bucket size of the label collision grid, in screen pixels. */
export const LABEL_GRID_CELL_PX = 64;
export const LABEL_COLOR = '#aeb7b5';
export const LABEL_ACTIVE_COLOR = '#f3f1eb';

// -- canvas -----------------------------------------------------------------

export const CANVAS_BACKGROUND = '#090a0b';
/**
 * Grid pitch in WORLD units, not screen pixels.
 *
 * The grid is the ground the map sits on: it pans and zooms with the nodes, so
 * dragging moves the two together and the graph reads as an object being moved
 * rather than as points sliding over stationary wallpaper.
 */
export const CANVAS_GRID_SIZE_PX = 48;
export const CANVAS_GRID_MAJOR_EVERY = 4;
/**
 * Coarsen the pitch below this on-screen spacing.
 *
 * Zoomed far out, one world cell collapses to less than a pixel; without this
 * the renderer would walk thousands of lines per frame to paint solid fog.
 * Doubling keeps every coarser grid a superset of the finer one, so lines stay
 * put as the zoom crosses a threshold instead of shuffling.
 */
export const CANVAS_GRID_MIN_SPACING_PX = 7;
export const CANVAS_GRID_MINOR_COLOR = 'rgba(69, 198, 212, 0.022)';
export const CANVAS_GRID_MAJOR_COLOR = 'rgba(69, 198, 212, 0.045)';
/**
 * Fill for a node outside the current expansion.
 *
 * Greyscale rather than dimmed: the surrounding map has to stay READABLE while
 * two concepts are open, because judging whether a new connection makes sense
 * depends on seeing what else is there. Alpha alone would fade the labels with
 * it, which defeats the purpose.
 */
export const GREYED_NODE_COLOR = '#4a5153';

/** View-only sub-concepts and their quiet parent ties. */
export const SUBNODE_LINK_COLOR = 'rgba(69, 198, 212, 0.42)';
export const SUBNODE_LINK_WIDTH = 1;
export const SUBNODE_LINK_DASH: readonly number[] = [3, 4];
export const SUBNODE_RING_COLOR = 'rgba(131, 221, 229, 0.72)';
export const SUBNODE_RING_WIDTH = 1.2;
export const SUBNODE_RING_GAP = 2.5;

/** World-space slack added to the cull rect so half-visible items still draw. */
export const CULL_MARGIN_PX = 96;

// -- layout loop ------------------------------------------------------------

/** Simulation steps per animation frame. */
export const LAYOUT_TICKS_PER_FRAME = 2;
/** Keyboard nudge: how far the selection can look for a neighbour, in world px. */
export const NAVIGATE_MAX_DISTANCE = 4000;
/** Half-angle of the cone an arrow key searches within, in radians. */
export const NAVIGATE_CONE_RADIANS = Math.PI / 4;

// The raster-export constants that lived here (JPG quality bounds, canvas
// dimension caps, thumbnail sizing) went with the JPG export itself. The
// remaining formats are HTML and YAML, neither of which rasterises anything.

// -- drawing an edge --------------------------------------------------------

/** The in-flight rubber-band line while the author drags a new connection. */
export const CONNECT_DRAFT_COLOR = '#45c6d4';
export const CONNECT_DRAFT_WIDTH = 1.6;
export const CONNECT_DRAFT_DASH: readonly number[] = [5, 4];
/** Solid, brighter, and ringed once the line is over a node it can land on. */
export const CONNECT_TARGET_COLOR = '#83dde5';
export const CONNECT_TARGET_RING_WIDTH = 2;
export const CONNECT_TARGET_RING_GAP = 4;

/**
 * Arrowheads. A typed, directed edge that renders identically to an
 * undirected one makes choosing the relation pointless — the direction has to
 * be visible on the canvas or the graph cannot be read as a flow.
 */
export const ARROWHEAD_LENGTH_PX = 9;
export const ARROWHEAD_HALF_ANGLE = Math.PI / 7;
/** Backs the head off the node rim so it points AT the node, not into it. */
export const ARROWHEAD_GAP_PX = 2;

// -- editing an edge --------------------------------------------------------

/**
 * How close a click must be to a curve to select it. Wider than the node slop
 * because a 1.5px line is far harder to hit than a disc.
 */
export const EDGE_HIT_SLOP_PX = 7;
/** Segments the quadratic is sampled into for hit-testing. */
export const EDGE_HIT_SAMPLES = 16;
/** A selected edge, so it is obvious which relationship is being edited. */
export const EDGE_SELECTED_COLOR = '#a8c4ff';
export const EDGE_SELECTED_WIDTH = 2.6;

// -- flow -------------------------------------------------------------------

/*
 * Cyan: flow is the graph's own structure being read, not Magistral acting.
 * Lime stays reserved for the discovery pulse, so the two remain legible when
 * both are on screen at once.
 */
export const FLOW_COLOR = '#7fe3ee';
export const FLOW_DOT_RADIUS_PX = 2;
/** Brightest mid-edge, fading at both ends so dots never sit under a node. */
export const FLOW_PEAK_ALPHA = 0.85;

// -- discovery pulses -------------------------------------------------------

/*
 * The mark's own gesture: a short line resolving into a precise endpoint.
 * Lime is spent only where Magistral itself did something — here, a
 * relationship arriving — so it stays scarce enough to keep meaning that.
 */
export const DISCOVERY_COLOR = '#b8db4c';
/** The travelling head of the pulse. */
export const DISCOVERY_DOT_RADIUS_PX = 2.6;
/** The endpoint it resolves into once it arrives. */
export const DISCOVERY_ENDPOINT_RADIUS_PX = 3.4;
/** Length of the short dash trailing the head, in curve parameter units. */
export const DISCOVERY_TRAIL = 0.12;

// -- recall pulses ----------------------------------------------------------

/**
 * The colour a node fires when a chat answer recalls it.
 *
 * Green because it has to read as "active now" against the blue-white the
 * graph uses for structure — a brighter blue would look like selection.
 */
export const RECALL_COLOR = '#b8db4c';
export const RECALL_GLOW_COLOR = 'rgba(184, 219, 76, 0.38)';
/** Extra radius at full intensity, in screen pixels. */
export const RECALL_HALO_PX = 14;
export const RECALL_RING_WIDTH = 2.4;

// -- group nodes ------------------------------------------------------------

/** The topology-aware enclosing region, drawn behind everything else. */
export const GROUP_FILL = 'rgba(69, 198, 212, 0.035)';
export const GROUP_STROKE = 'rgba(69, 198, 212, 0.25)';
export const GROUP_STROKE_WIDTH = 1.4;
export const GROUP_DASH: readonly number[] = [7, 6];
/** Breathing room between the outermost member and the ring. */
export const GROUP_PADDING_PX = 34;
/** An empty group still needs an area to drop the first node into. */
export const GROUP_MIN_RADIUS_PX = 52;
/**
 * How far past the ring a member must be dragged before it leaves its group.
 *
 * Joining is instant — dropping a node inside a circle plainly means "put it
 * in here". Leaving is not the mirror of that: membership is a claim the
 * author made on purpose, and nudging a node a pixel past a dashed line is not
 * them retracting it. Without this margin, tidying the layout quietly
 * dissolves groups. Generous by design; it should take intent, not precision.
 */
export const GROUP_EXIT_MARGIN_PX = 64;
export const GROUP_LABEL_COLOR = 'rgba(131, 221, 229, 0.78)';
export const GROUP_LABEL_FONT =
  '600 11px "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace';
/** Highlight while a dragged node is over the group and would join it. */
export const GROUP_ACTIVE_FILL = 'rgba(69, 198, 212, 0.1)';
export const GROUP_ACTIVE_STROKE = 'rgba(131, 221, 229, 0.82)';
