import { Skeleton } from "@/components/skeleton";

/**
 * Brain graph loading skeleton - the string-free, server-renderable
 * placeholder shared by the Brain route fallback (`brain/loading.tsx` via
 * `BrainSurfaceSkeleton`) and the graph's FIRST cold in-surface fetch.
 *
 * It mirrors the finished canvas's geometry in skeleton colour only: a
 * clustered force-graph composition (circular nodes, short label bars, fine
 * static edges) plus the three overlay chips the live canvas draws - the
 * stats strip top-left, the colour-mode toggle and zoom controls top-right,
 * the legend bottom-left - so the swap-in changes nothing but the pixels
 * inside the shapes. No literal brain outline, no entity hue, no second animation
 * system: the shared `.skeleton` shimmer is the only motion.
 *
 * Built from positioned `<div>`s over ONE `<svg>` path rather than an SVG of
 * `<foreignObject>`s: a foreignObject per node made the browser lay out 19
 * nested HTML islands inside the SVG (and mis-clip them on WebKit), and 40
 * separate `<line>` elements cost 40 DOM nodes for one static stroke. Now
 * the edges are a single `<path d>` and each node is two absolutely
 * positioned blocks - the same primitive the rest of the app's skeletons
 * use, at a fraction of the layout work.
 *
 * Spec: docs/architecture/features/perceived-performance.md;
 * docs/architecture/brain/graph-view.md -> "Loading state".
 */

type GraphSkeletonNode = {
  /** Percent of the canvas width / height. */
  x: number;
  y: number;
  /** Disc diameter in px. */
  size: number;
  /** Label bar width in px. */
  label: number;
  hub?: boolean;
};

// A settled composition whose outer nodes form a loose brain-shaped
// silhouette. The asymmetry is deliberate: real d3 layouts settle into
// clusters, not mirrored diagrams. Coordinates are percentages so the
// composition scales with the pane instead of letterboxing inside it.
const GRAPH_NODES: GraphSkeletonNode[] = [
  { x: 50, y: 49, size: 24, label: 70, hub: true },
  { x: 40.5, y: 33, size: 18, label: 54, hub: true },
  { x: 59.5, y: 33.5, size: 18, label: 58, hub: true },
  { x: 46, y: 16, size: 14, label: 42 },
  { x: 55, y: 18, size: 12, label: 36 },
  { x: 27, y: 24, size: 18, label: 62, hub: true },
  { x: 73, y: 25, size: 16, label: 56 },
  { x: 35, y: 49, size: 16, label: 48 },
  { x: 65, y: 48.5, size: 16, label: 50 },
  { x: 15.5, y: 49, size: 20, label: 68, hub: true },
  { x: 84.5, y: 50, size: 18, label: 64, hub: true },
  { x: 39, y: 68, size: 16, label: 52 },
  { x: 61, y: 68, size: 16, label: 54 },
  { x: 21.5, y: 70, size: 16, label: 60 },
  { x: 78, y: 71.5, size: 14, label: 56 },
  { x: 31, y: 86, size: 14, label: 48 },
  { x: 69, y: 86.5, size: 14, label: 48 },
  { x: 44.5, y: 84.5, size: 12, label: 38 },
  { x: 56, y: 85.5, size: 12, label: 40 },
];

const GRAPH_EDGES: Array<[number, number]> = [
  [0, 1], [0, 2], [0, 7], [0, 8], [0, 11], [0, 12], [0, 17], [0, 18],
  [1, 2], [11, 12],
  [1, 3], [1, 5], [1, 7], [3, 4], [3, 5], [5, 7], [5, 9], [7, 9],
  [7, 11], [9, 13], [11, 13], [11, 15], [11, 17], [13, 15], [15, 17],
  [2, 4], [2, 6], [2, 8], [4, 6], [6, 8], [6, 10], [8, 10], [8, 12],
  [10, 14], [12, 14], [12, 16], [12, 18], [14, 16], [16, 18],
];

/** One `<path>` for every edge, in a 100x100 percentage space. */
const EDGE_PATH = GRAPH_EDGES.map(([from, to]) => {
  const a = GRAPH_NODES[from]!;
  const b = GRAPH_NODES[to]!;
  return `M${a.x} ${a.y}L${b.x} ${b.y}`;
}).join("");

const SKELETON_COLOR =
  "color-mix(in srgb, var(--muted-foreground) 12%, transparent)";

export function BrainGraphLoadingSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-brain-graph-skeleton="true"
      className="absolute inset-0 overflow-hidden bg-[var(--graph-bg)]"
    >
      {/* The composition sits in a padded box so its outer nodes never
          touch the overlay chips or the pane edge. */}
      <div className="absolute inset-[7%] sm:inset-[9%]">
        <svg
          data-brain-graph-edges="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          <path
            d={EDGE_PATH}
            fill="none"
            stroke={SKELETON_COLOR}
            strokeLinecap="round"
            strokeWidth="0.35"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {GRAPH_NODES.map((node, index) => (
          <div
            key={index}
            className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
          >
            <Skeleton
              data-brain-graph-node={node.hub ? "hub" : "node"}
              className="shrink-0 rounded-full"
              style={{ width: node.size, height: node.size }}
            />
            <Skeleton
              data-brain-graph-label={index}
              className="mt-[5px] h-1 rounded-full"
              style={{ width: node.label }}
            />
          </div>
        ))}
      </div>

      {/* Overlay chip stand-ins - stats strip, colour-mode toggle, legend -
          at the live canvas's exact anchors. */}
      <div className="absolute left-2 top-2 flex flex-col gap-1.5">
        <Skeleton className="h-6 w-44 rounded-md" />
      </div>
      <Skeleton className="absolute right-2 top-2 h-6 w-[7.5rem] rounded-md" />
      <Skeleton className="absolute right-2 top-11 h-[5.5rem] w-7 rounded-md" />
      <Skeleton className="absolute bottom-2 left-2 h-6 w-40 rounded-md" />
    </div>
  );
}
