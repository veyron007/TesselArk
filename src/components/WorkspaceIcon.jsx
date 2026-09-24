const paths = {
  dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  orders: 'M3 4h2l2 12h11l3-8H6 M9 20h.01 M17 20h.01',
  catalogue: 'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z M13 7a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2',
  operations: 'M4 3h12l4 4v14H4z M8 9h8 M8 13h8 M8 17h5',
  batches: 'm12 3 9 5-9 5-9-5z M3 8v10l9 4 9-4V8 M12 13v9',
  locations: 'm3 9 9-6 9 6v12H3z M8 21V11h8v10 M8 16h8',
  conversion: 'M4 7h15l-4-4 M20 17H5l4 4 M19 7l-4 4 M5 17l4-4',
  counts: 'M9 4H5v17h14V4h-4 M9 2h6v5H9z M8 12l2 2 5-5 M8 18h7',
  pricing: 'M3 3h9l9 9-9 9-9-9z M7 7h.01',
  credit: 'M3 6h18v13H3z M3 10h18 M7 15h4',
  finance: 'M6 3h12 M6 7h12 M7 3a5 5 0 0 1 0 10h-1l10 8',
  accounting: 'M5 3h14v18H5z M8 7h8 M8 11h2 M14 11h2 M8 15h2 M14 15h2 M8 18h2 M14 18h2',
  bank: 'm3 7 9-4 9 4z M5 10v8 M10 10v8 M14 10v8 M19 10v8 M3 21h18',
  cashier: 'M5 3h14v18l-3-2-4 2-4-2-3 2z M8 8h8 M8 12h8 M8 16h3',
  reporting: 'M4 3v18h17 M8 17v-5 M13 17V8 M18 17V4',
  returns: 'M8 4 3 9l5 5 M3 9h11a6 6 0 0 1 0 12h-4',
  evidence: 'M14 3H5v18h14V8z M14 3v5h5 M8 12h8 M8 16h6',
  gst: 'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h3 M8 18h8',
  'invoice-checks': 'M5 3h14v18H5z M8 8h8 M8 12l2 2 5-5 M8 18h8',
  simulator: 'M8 3h8 M10 3v6l-6 11h16L14 9V3 M8 15h8',
  'access-grants': 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z M8 12l3 3 5-6',
  coverage: 'M4 3h16v18H4z M8 8l1 1 2-2 M13 8h4 M8 14l1 1 2-2 M13 14h4',
};

export default function WorkspaceIcon({ name, className = '' }) {
  const key = name.startsWith('return-') ? 'returns' : name === 'statement-import' ? 'evidence' : name;
  return <svg className={className} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[key] || paths.operations} /></svg>;
}

export function BrandMark() {
  return <svg width="38" height="38" viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M4 28 23 5l5 7L10 34z" fill="#59adff" /><path d="m13 33 17-20 5 8-17 15z" fill="#2878ed" /><path d="m23 35 13-12 2 11z" fill="#244fb8" /></svg>;
}
