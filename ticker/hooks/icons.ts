// Icons, hand-drawn and a little uneven, in Claude clay. Source: tools/icons.py.
// Each is a 24 by 24 SVG; sized() sets the size it draws at.

export const arrow = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M12.3 19.8 C12.1 15.2 11.8 10.4 12.1 5.2 M7.1 10.1 C8.9 8.2 10.6 6.4 12.1 4.6 C13.7 6.1 15.4 7.9 17.2 9.4\" fill=\"none\" stroke=\"#D97757\" stroke-width=\"2.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>"

/** The icon at `px` CSS pixels. */
export function sized(svg: string, px: number): string {
  return svg.replace('width="24" height="24"', `width="${px}" height="${px}"`)
}

// The line's wave moves as Claude's own working icons do: it grows from a dot
// and draws itself in, sways while the command runs, and draws back into the
// dot when the line goes. CSS only: the desktop app keeps the frame of an
// unchanged source across redraws, so the wave never restarts mid-sway.

/** Seconds: the draw in, one sway, the time the undraw holds still, the undraw. */
export const DRAW_S = 1.2
export const SWAY_S = 4.8
export const HOLD_S = 0.5
export const UNDRAW_S = 1.2

/** The wave at rest, and the two shapes its sway passes through. */
const WAVE = 'M2.2 13.6 C4.1 13.9 4.6 9.4 6.6 9.1 C8.9 8.8 8.6 16.9 11.2 17.2 C13.6 17.5 13.4 5.4 16.1 5.1 C18.3 4.9 18.2 12.8 21.8 12.1'
const LIFTED = 'M2.2 13.6 C4.1 13.9 4.9 8.3 6.9 8.0 C9.2 7.7 8.8 16.1 11.4 16.4 C13.8 16.7 13.1 6.5 15.8 6.2 C18.0 6.0 18.2 12.3 21.8 11.6'
const DIPPED = 'M2.2 13.3 C4.1 13.6 4.3 10.4 6.3 10.1 C8.6 9.8 8.4 17.5 11.0 17.8 C13.4 18.1 13.7 4.6 16.4 4.3 C18.6 4.1 18.2 13.3 21.8 12.6'
const LINE = 'stroke="#D97757" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" fill="none" pathLength="100" stroke-dasharray="100 101"'
const EASE_OUT = 'cubic-bezier(.3,0,.2,1)'
const EASE_IN_OUT = 'cubic-bezier(.45,0,.55,1)'
// A dash offset of 99.5 leaves one round dot at the wave's start; 0 shows the whole wave.
const SWAY = `@keyframes s{0%,50%,100%{d:path("${WAVE}")}25%{d:path("${LIFTED}")}75%{d:path("${DIPPED}")}}`
const DRAW_IN = '@keyframes i{0%{stroke-dashoffset:99.5;stroke-width:0}27%{stroke-dashoffset:99.5;stroke-width:2.3px}100%{stroke-dashoffset:0;stroke-width:2.3px}}'
const UNDRAW_AT = (HOLD_S / (HOLD_S + UNDRAW_S)) * 100
const DOT_AT = ((HOLD_S + UNDRAW_S * 0.73) / (HOLD_S + UNDRAW_S)) * 100
const UNDRAW = `@keyframes o{0%,${UNDRAW_AT.toFixed(1)}%{stroke-dashoffset:0;stroke-width:2.3px;animation-timing-function:${EASE_IN_OUT}}${DOT_AT.toFixed(1)}%{stroke-dashoffset:99.5;stroke-width:2.3px;animation-timing-function:${EASE_IN_OUT}}100%{stroke-dashoffset:99.5;stroke-width:0}}`

/** One frame's markup at `px`, its left edge `inset` pixels before the wave starts, so the wave lines up under a row's text. */
function frame(px: number, inset: number, style: string, body: string) {
  const units = (inset * 24) / px
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px + inset}" height="${px}" viewBox="${-units} 0 ${24 + units} 24">${style}${body}</svg>`
}

/** The sway, in step with a wave first drawn `ageS` seconds ago. */
function sway(ageS: number) {
  return `s ${SWAY_S}s ${EASE_IN_OUT} ${(DRAW_S - ageS).toFixed(2)}s infinite`
}

/**
 * The wave while its command runs. A wave first drawn `ageS` seconds ago
 * carries on where it was; at 0 it draws itself in from the dot.
 */
export function waveRunning(px: number, inset: number, ageS = 0): string {
  const draw = ageS < DRAW_S ? `i ${DRAW_S}s ${EASE_OUT} ${(-ageS).toFixed(2)}s both,` : ''
  return frame(px, inset, `<style>.w{animation:${draw}${sway(ageS)}}${DRAW_IN}${SWAY}</style>`, `<path class="w" d="${WAVE}" ${LINE}/>`)
}

/**
 * The wave as its line goes: drawn over the running wave, it holds still for
 * HOLD_S while its frame loads, then draws back into the dot, which shrinks away.
 */
export function waveUndraw(px: number, inset: number, ageS: number): string {
  return frame(px, inset, `<style>.w{animation:o ${HOLD_S + UNDRAW_S}s linear both,${sway(ageS)}}${UNDRAW}${SWAY}</style>`, `<path class="w" d="${WAVE}" ${LINE}/>`)
}

/** An empty frame the size of the wave's, drawn in its place once the undraw covers it. */
export function waveCleared(px: number, inset: number): string {
  return frame(px, inset, '', '')
}
