// Icons, hand-drawn and a little uneven, in Claude clay. Source: tools/icons.py.
// Each is a 24 by 24 SVG; sized() sets the size it draws at.

export const tape = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><style>.t{stroke-dasharray:36 140;animation:m 1.8s cubic-bezier(.45,.05,.55,.95) infinite}@keyframes m{from{stroke-dashoffset:38}to{stroke-dashoffset:-102}}</style><path d=\"M2.2 13.6 C4.1 13.9 4.6 9.4 6.6 9.1 C8.9 8.8 8.6 16.9 11.2 17.2 C13.6 17.5 13.4 5.4 16.1 5.1 C18.3 4.9 18.2 12.8 21.8 12.1\" stroke=\"#D97757\" stroke-width=\"2.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" fill=\"none\" opacity=\".28\"/><path class=\"t\" d=\"M2.2 13.6 C4.1 13.9 4.6 9.4 6.6 9.1 C8.9 8.8 8.6 16.9 11.2 17.2 C13.6 17.5 13.4 5.4 16.1 5.1 C18.3 4.9 18.2 12.8 21.8 12.1\" pathLength=\"100\" stroke=\"#D97757\" stroke-width=\"2.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" fill=\"none\"/></svg>"

export const arrow = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M12.3 19.8 C12.1 15.2 11.8 10.4 12.1 5.2 M7.1 10.1 C8.9 8.2 10.6 6.4 12.1 4.6 C13.7 6.1 15.4 7.9 17.2 9.4\" fill=\"none\" stroke=\"#D97757\" stroke-width=\"2.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>"

/** The icon at `px` CSS pixels. */
export function sized(svg: string, px: number): string {
  return svg.replace('width="24" height="24"', `width="${px}" height="${px}"`)
}
