// What a chart's box shows while the chart code (recharts, split off so it does
// not load with the view) arrives: the spinner the views show while data loads.
// Fills the sized container it is dropped into, so nothing shifts when the plot
// replaces it.
export default function ChartFallback() {
  return (
    <div className="chart-empty" aria-busy="true">
      <div className="spinner" />
    </div>
  );
}
