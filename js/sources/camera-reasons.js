// Plain-word reasons for pictures and seconds the camera could not turn into a reading. Pure, no DOM.
//
//   explainMiss(reason)        reason = readDisplay(...).debug.reason  ->  { label, text, hint }
//   explainRejection(outcome)  outcome = filter.lastOutcome()          ->  { label, text } or null
//
// `label` is a short phrase that doubles as the tally key ("9 unclear digit, 3 jump too big") on the Camera details panel
// and in the saved roast's reader health (reader.missReasons), so keep the labels stable.

const MISSES = [
  { match: /cut off at the right edge/, label: 'digit cut off', text: 'A digit is cut off at the right edge.', hint: 'Move the box right.' },
  { match: /^low contrast/, label: 'too faint', text: 'The digits are too faint.', hint: 'Add light or reduce glare.' },
  { match: /^(ambiguous segment|segments mid-fade|invalid pattern|bad hundreds digit)/, label: 'unclear digit', text: 'Part of a digit is unclear.', hint: 'Check for glare, focus and that the phone is square-on.' },
  { match: /^(no digit found|too few digits|ones digit blank|gap in digits)/, label: 'no digits found', text: 'No digits found in the box.', hint: 'Move the box over the top-right number.' },
  { match: /^ink right of the ones digit/, label: 'ink beside number', text: 'Something is inside the box to the right of the number.', hint: 'Leave out the °F.' },
  { match: /^crop too small/, label: 'box too small', text: 'The box is too small to read.', hint: 'Make the box bigger.' },
  { match: /^out of display range/, label: 'impossible number', text: 'The reader saw a number the thermometer cannot show.', hint: 'Check that the box covers only the top-right number.' },
  { match: /^reader error/, label: 'reader error', text: 'The reader hit an error on this picture.', hint: '' },
];

export const NO_PICTURE = { label: 'no picture', text: 'No new pictures from the camera.', hint: '' };
export const NO_PROBE = { label: 'no probe', text: 'The display shows dashes: no probe reading.', hint: '' };

export function explainMiss(reason) {
  const r = String(reason || '');
  for (const m of MISSES) if (m.match.test(r)) return { label: m.label, text: m.text, hint: m.hint };
  return { label: 'unreadable', text: 'The reader could not read this picture.', hint: 'Check for glare, focus and that the phone is square-on.' };
}

// Filter outcomes that mean "the picture read fine but the second was rejected".
export function explainRejection(o) {
  if (!o) return null;
  if (o.kind === 'range') return { label: 'out of range', text: `The reading ${o.value} is outside the accepted range.` };
  if (o.kind === 'jump') return { label: 'jump too big', text: `The reading jumped from ${o.last} to ${o.value}, too big a jump, so it was not accepted.` };
  if (o.kind === 'disagree') return { label: 'frames disagreed', text: `The pictures in this second disagreed (${(o.values || []).join(', ')}).` };
  return null;
}

// A file-name piece for a reader reason: "ambiguous segment" -> "ambiguous-segment".
export const slug = (s) => String(s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unknown';
