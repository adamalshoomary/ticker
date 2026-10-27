import math, json
CLAY = '#D97757'

def tape(anim=True, size=24, offset=None):
    # A hand-drawn ticker line with uneven peaks. Moving, a faint copy stays put
    # while one bright stroke grows in at the start, travels, and shrinks away
    # at the end, so nothing pops in or out and the loop has no seam.
    d = "M2.2 13.6 C4.1 13.9 4.6 9.4 6.6 9.1 C8.9 8.8 8.6 16.9 11.2 17.2 C13.6 17.5 13.4 5.4 16.1 5.1 C18.3 4.9 18.2 12.8 21.8 12.1"
    line = f'stroke="{CLAY}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" fill="none"'
    head = f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24">'
    if not anim:
        return f'{head}<path d="{d}" {line}/></svg>'
    still = '' if offset is None else f' style="stroke-dashoffset:{offset}"'
    style = '' if offset is not None else '<style>.t{stroke-dasharray:36 140;animation:m 1.8s cubic-bezier(.45,.05,.55,.95) infinite}@keyframes m{from{stroke-dashoffset:38}to{stroke-dashoffset:-102}}</style>'
    dash = '' if offset is None else ' stroke-dasharray="36 140"'
    return (f'{head}{style}<path d="{d}" {line} opacity=".28"/>'
            f'<path class="t" d="{d}" pathLength="100"{dash}{still} {line}/></svg>')

def spark(cx, cy, scale):
    # Uneven tapered rays, wide at the root and pointed at the tip, no two alike.
    rays = [(-78, 1.0, .34), (-14, .62, .30), (38, .86, .32), (104, .55, .28), (158, .92, .33), (221, .68, .30)]
    out = []
    for ang, ln, w in rays:
        a = math.radians(ang)
        tx, ty = cx + math.cos(a) * ln * scale, cy + math.sin(a) * ln * scale
        nx, ny = -math.sin(a) * w * scale * .5, math.cos(a) * w * scale * .5
        out.append(f'M{cx+nx:.2f} {cy+ny:.2f} Q{(cx+tx)/2+nx*.6:.2f} {(cy+ty)/2+ny*.6:.2f} {tx:.2f} {ty:.2f} Q{(cx+tx)/2-nx*.6:.2f} {(cy+ty)/2-ny*.6:.2f} {cx-nx:.2f} {cy-ny:.2f}Z')
    return ' '.join(out)

def moon(state='off', size=24, anim=True):
    # A crescent a little off true: the inner arc is wider than the outer.
    crescent = "M14.6 3.3 C9.2 3.1 4.4 7.4 4.6 13.2 C4.8 18.4 9.6 21.4 14.2 20.6 C17.3 20.1 19.6 18.2 20.6 15.9 C15.2 17.1 10.6 13.4 10.9 8.6 C11.1 6.4 12.4 4.5 14.6 3.3 Z"
    if state == 'off':
        body = f'<path d="{crescent}" fill="none" stroke="{CLAY}" stroke-width="1.9" stroke-linejoin="round" opacity="0.85"/>'
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24">{body}</svg>'
    # On: the filled moon breathes. Its inner curve bends in and its lower tip
    # curls, then both ease back. On its own slower beat the whole moon rocks
    # about 10 degrees each way, so the two never line up the same.
    thin = "M14.6 3.3 C9.2 3.1 4.4 7.4 4.6 13.2 C4.8 18.4 9.6 21.4 14.2 20.6 C16.6 20.2 18.4 19.0 19.4 17.6 C13.4 18.6 8.3 15.4 8.2 10.0 C8.1 7.2 10.6 4.6 14.6 3.3 Z"
    if state == 'thin':
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24"><path d="{thin}" fill="{CLAY}"/></svg>'
    style = '<style>.r{transform-box:view-box;transform-origin:12px 12px;animation:s 5.2s ease-in-out infinite}@keyframes s{0%,100%{transform:rotate(-11deg)}50%{transform:rotate(9deg)}}</style>' if anim else ''
    breathe = (f'<animate attributeName="d" dur="4s" repeatCount="indefinite" values="{crescent};{thin};{crescent}" '
               'keyTimes="0;.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1"/>') if anim else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24">{style}<g class="r"><path d="{crescent}" fill="{CLAY}">{breathe}</path></g></svg>'

def arrow(size=24):
    # An up arrow drawn in one uneven stroke, for a new version.
    d = "M12.3 19.8 C12.1 15.2 11.8 10.4 12.1 5.2 M7.1 10.1 C8.9 8.2 10.6 6.4 12.1 4.6 C13.7 6.1 15.4 7.9 17.2 9.4"
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24"><path d="{d}" fill="none" stroke="{CLAY}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'

icons = {'spark': f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="{spark(12,12,10.5)}" fill="{CLAY}"/></svg>', 'tape': tape(), 'tapeStill': tape(False), 'moonOff': moon('off'), 'moonOn': moon('on'), 'arrow': arrow()}
json.dump(icons, open(__import__('sys').argv[1], 'w'), indent=1)
html = '<html><body style="font:14px sans-serif;display:flex;gap:40px;padding:30px">' + ''.join(f'<div>{k}<br>{v.replace("width=\"24\" height=\"24\"","width=\"96\" height=\"96\"")}<br>{v}</div>' for k, v in icons.items()) + '</body></html>'
html2 = html.replace('<body style="', '<body style="background:#1f1e1d;color:#eee;')
open(__import__('sys').argv[2], 'w').write(html + html2)
