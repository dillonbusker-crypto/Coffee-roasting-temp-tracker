// The Roast review card: the headline and one row per check from core/review.js.
//
//   const review = renderRoastReview(container, record, { reference, units, settings });
//   review.update(record)          // after the weight or the heat/fan log changed
//   review.setReference(record)    // a reference roast found later (or null)
//
// The review is worked out from the record each time and never stored. Rows are plain text
// (not tappable); the status is a word in a chip, not colour alone, and info rows have no chip.

import { h, clear } from './dom.js';
import { reviewRoast } from '../core/review.js';
import { getRoast, findReference } from '../store/db.js';

const CHIP = { good: 'On target', close: 'Close', off: 'Off target' };

// Ranges (5:00–5:30, 11–12%) and temperatures (15°F, 25°C/min) must not break across lines.
// The text is unchanged; the matches are only wrapped in a nowrap span.
const UNBREAKABLE = /\d+(?::\d\d)?%?–\d+(?::\d\d)?%?|\d+(?:\.\d+)?°[FC](?:\/min)?/g;
function rich(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(UNBREAKABLE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('span', { class: 'nb' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// The roast to compare with: its own settings.referenceId if that roast still exists, else the
// reference for its coffee (its own, then the general one). Never the roast itself. Resolves to
// null when there is none or the store cannot be read.
export async function resolveReviewReference(record) {
  if (!record) return null;
  let ref = null;
  const refId = record.settings && record.settings.referenceId;
  if (refId && refId !== record.id) {
    try { ref = await getRoast(refId); } catch { ref = null; }
  }
  if (!ref) {
    try { ref = await findReference(record.coffee); } catch { ref = null; }
  }
  return ref && ref.id !== record.id ? ref : null;
}

function headlineKind(review) {
  const { good, close, off } = review.counts;
  if (off > 0) return 'bad';
  if (close > 0) return 'warn';
  return good > 0 ? 'good' : 'none';
}

export function renderRoastReview(container, record, { reference = null, units = 'F', settings = null } = {}) {
  let rec = record;
  let ref = reference;

  const headline = h('p', { class: 'result-line review-headline', id: 'review-headline', 'data-kind': 'none' });
  const list = h('ul', { class: 'review-list', id: 'review-list' });
  const card = h('section', { class: 'card review-card', id: 'roast-review' },
    h('h2', null, 'Roast review'), headline, list);
  container.append(card);

  function draw() {
    let review;
    try {
      review = reviewRoast(rec, { reference: ref, units, settings });
    } catch (err) {
      review = null;
    }
    clear(list);
    if (!review) {
      headline.textContent = 'The review could not be worked out for this roast.';
      headline.dataset.kind = 'none';
      return;
    }
    headline.textContent = review.headline;
    headline.dataset.kind = headlineKind(review);
    for (const it of review.items) {
      list.append(h('li', { class: 'review-item', id: `review-${it.id}`, 'data-id': it.id, 'data-status': it.status },
        h('div', { class: 'review-head' },
          it.status === 'info' ? null : h('span', { class: 'rv-chip', 'data-status': it.status }, CHIP[it.status]),
          h('b', { class: 'review-title' }, it.title)),
        h('p', { class: 'review-text' }, ...rich(it.text))));
    }
  }
  draw();

  return {
    el: card,
    update(next) { rec = next; draw(); },
    setReference(next) { ref = next || null; draw(); },
  };
}
