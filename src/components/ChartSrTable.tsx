import React from 'react';

/**
 * Screen-reader table alternative for a chart. Render it as a sibling of the
 * chart; give the chart wrapper role="img" + aria-label. Charts get a text
 * alternative, not a better tooltip — hover is unreliable on touch and AT.
 */
export default function ChartSrTable({ caption, columns, rows }: {
  caption: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}
