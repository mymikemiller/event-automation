# Mobile-friendly UI — design

Date: 2026-08-20

## Problem

The web app is hard to use on a phone. Text fields render very short
vertically and are awkward to paste into.

## Root cause

`doGet()` returned the HtmlOutput without a viewport meta tag. Apps Script
serves page HTML inside a sandboxed iframe, so the `<meta name="viewport">`
in `Index.html` applies only to the inner document — the outer Google page
has none. Mobile browsers therefore lay the outer page out at a ~980px
virtual width and scale it down, shrinking every control.

`HtmlService.HtmlOutput.addMetaTag()` is the supported way to put a tag on
the outer page. That one line recovers most of the readability; the rest of
this design is touch ergonomics that remain once the scaling is fixed.

## Decisions

**Nothing collapses.** The confirm screen exists so a human proofreads what
was auto-extracted. Anything hidden behind a fold is something you can
approve without reading. Sections get visual grouping via separate cards
with headers, but every field stays on screen.

**Sticky action bar, as progressive enhancement.** The primary button sits
in a `position: sticky; bottom: 0` bar. Where sticky does not engage — the
containing card shorter than the viewport, or an Apps Script iframe sized
to full content height — the bar lands in normal flow at the bottom of the
form, which is exactly where the button sits today. No behavior is lost.

**Date rows become stacked cards.** The old `.date-row` put a date input,
two time inputs, a separator, an exception tag and a remove button on one
flex line. On a narrow screen each control was a few characters wide. Each
occurrence becomes a bordered card: a header carrying its ordinal, the
exception tag and a 40px remove target; a full-width date input; then start
and end times side by side at half width each.

The DOM contract that the surrounding code depends on is preserved:
`readDateRows()` indexes `getElementsByTagName('input')` as
`[date, start, end]`, and `renderPlan()`/`onDatesChanged()` look up
`.diff-tag` and `.rm` by class. Input order and both class names are kept.
`removeDateRow()` changes from `btn.parentNode` to `btn.closest('.date-card')`,
since the button is now nested one level deeper than the card.

## Sizing

- Root type scale 16px. Inputs at `font-size: 1rem` — below 16px, mobile
  browsers zoom the page on focus.
- 48px minimum touch target on inputs and add-date; 52px on action buttons.
- `#paste-input` 260px, `#f-description` 180px — both are paste targets.
- Image preview `max-height: 60vh`, full width.

## Testing

`tests/run.js` loads pure `.gs` files into a VM sandbox and has no DOM
harness, so there is nothing here to unit test. Verification is manual:
load the deployed URL in mobile Firefox and on desktop, walk the extract →
confirm → result flow, and confirm the multi-date editor still reads and
writes the same occurrence data.
