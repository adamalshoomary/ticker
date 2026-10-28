import math, json
CLAY = '#D97757'

# The line's wave. hooks/icons.ts builds the same markup at run time (waveRunning,
# waveUndraw), since the app needs the line's age and inset; these two are for
# the install page and the card. It grows from a dot and draws itself in, then
# sways through two hand-drawn shapes, as Claude's own working icons move.
WAVE = "M2.2 13.6 C4.1 13.9 4.6 9.4 6.6 9.1 C8.9 8.8 8.6 16.9 11.2 17.2 C13.6 17.5 13.4 5.4 16.1 5.1 C18.3 4.9 18.2 12.8 21.8 12.1"
LIFTED = "M2.2 13.6 C4.1 13.9 4.9 8.3 6.9 8.0 C9.2 7.7 8.8 16.1 11.4 16.4 C13.8 16.7 13.1 6.5 15.8 6.2 C18.0 6.0 18.2 12.3 21.8 11.6"
DIPPED = "M2.2 13.3 C4.1 13.6 4.3 10.4 6.3 10.1 C8.6 9.8 8.4 17.5 11.0 17.8 C13.4 18.1 13.7 4.6 16.4 4.3 C18.6 4.1 18.2 13.3 21.8 12.6"
LINE = f'stroke="{CLAY}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" fill="none" pathLength="100" stroke-dasharray="100 101"'

def wave(anim=True, size=24):
    head = f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24">'
    if not anim:
        return f'{head}<path d="{WAVE}" {LINE}/></svg>'
    style = ('<style>.w{animation:i 1.2s cubic-bezier(.3,0,.2,1) 0.00s both,s 4.8s cubic-bezier(.45,0,.55,1) 1.20s infinite}'
             '@keyframes i{0%{stroke-dashoffset:99.5;stroke-width:0}27%{stroke-dashoffset:99.5;stroke-width:2.3px}100%{stroke-dashoffset:0;stroke-width:2.3px}}'
             f'@keyframes s{{0%,50%,100%{{d:path("{WAVE}")}}25%{{d:path("{LIFTED}")}}75%{{d:path("{DIPPED}")}}}}</style>')
    return f'{head}{style}<path class="w" d="{WAVE}" {LINE}/></svg>'

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

icons = {'spark': f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="{spark(12,12,10.5)}" fill="{CLAY}"/></svg>', 'wave': wave(), 'waveStill': wave(False), 'moonOff': moon('off'), 'moonOn': moon('on'), 'arrow': arrow()}
json.dump(icons, open(__import__('sys').argv[1], 'w'), indent=1)
html = '<html><body style="font:14px sans-serif;display:flex;gap:40px;padding:30px">' + ''.join(f'<div>{k}<br>{v.replace("width=\"24\" height=\"24\"","width=\"96\" height=\"96\"")}<br>{v}</div>' for k, v in icons.items()) + '</body></html>'
html2 = html.replace('<body style="', '<body style="background:#1f1e1d;color:#eee;')
open(__import__('sys').argv[2], 'w').write(html + html2)
