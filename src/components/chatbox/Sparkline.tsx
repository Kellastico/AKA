/**
 * Minimal inline-SVG sparkline for the Context Window modal's hardware rows.
 *
 * Deliberately not a chart library: this draws one polyline of at most a few
 * hundred points, twice, inside a popover.
 *
 * Points carry their own timestamp so a pause in sampling renders as a break
 * in the line rather than a straight segment across the gap — a flat line
 * would read as "0% for five minutes", which is a different claim from "we
 * weren't looking".
 */
export function Sparkline({
  points,
  max = 100,
  className,
}: {
  points: { atMs: number; value: number }[];
  /** Top of the y-axis. Values above it clamp. */
  max?: number;
  className?: string;
}) {
  if (points.length < 2) return null;

  const width = 100;
  const height = 20;
  const firstMs = points[0].atMs;
  const spanMs = Math.max(points[points.length - 1].atMs - firstMs, 1);

  // A gap this much larger than the typical step means sampling paused.
  const steps = points
    .slice(1)
    .map((p, i) => p.atMs - points[i].atMs)
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const median = steps.length > 0 ? steps[Math.floor(steps.length / 2)] : 1000;
  const gapMs = median * 3;

  const x = (atMs: number) => ((atMs - firstMs) / spanMs) * width;
  const y = (value: number) =>
    height - (Math.min(Math.max(value, 0), max) / max) * height;

  // Split into unbroken runs, one polyline each.
  const runs: string[][] = [[]];
  points.forEach((p, i) => {
    if (i > 0 && p.atMs - points[i - 1].atMs > gapMs) runs.push([]);
    runs[runs.length - 1].push(`${x(p.atMs).toFixed(2)},${y(p.value).toFixed(2)}`);
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
      className={["h-5 w-full", className ?? ""].join(" ")}
    >
      {runs
        .filter((run) => run.length > 1)
        .map((run, i) => (
          <polyline
            key={i}
            points={run.join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
    </svg>
  );
}
