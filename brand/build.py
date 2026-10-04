# Builds the Memento Mori marks: symbol, small cut, reversed cut, wordmark and lockups.
import math, sys
OUT = sys.argv[1] if len(sys.argv) > 1 else '.'   # python brand/build.py brand
INK, ACCENT = '#1C1C1E', '#2463EB'
f = lambda v: f'{v:.2f}'.rstrip('0').rstrip('.')

def hourglass(c=128, r=108, n=9):
    """Coin with its sides cut away: two 30° walls meet at a 2n-wide waist."""
    deg = 60 + math.degrees(math.asin(n / (2 * r)))
    s, co = r * math.sin(math.radians(deg)), r * math.cos(math.radians(deg))
    return (f'M{f(c-s)} {f(c-co)}A{r} {r} 0 0 1 {f(c+s)} {f(c-co)}L{f(c+n)} {c}'
            f'L{f(c+s)} {f(c+co)}A{r} {r} 0 0 1 {f(c-s)} {f(c+co)}L{f(c-n)} {c}Z')

def svg(w, h, body, title='Memento Mori logo'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f(w)} {f(h)}"><title>{title}</title>{body}</svg>\n'

# --- wordmark: geometric monoline lowercase built from rects, half-annuli and rings ----
H, W = 100, 17            # x-height, stem weight
def rect(x, y, w, h): return f'M{f(x)} {f(y)}H{f(x+w)}V{f(y+h)}H{f(x)}Z'
def pt(cx, cy, r, a): return cx + r*math.cos(math.radians(a)), cy + r*math.sin(math.radians(a))
def sector(cx, cy, ro, ri, a0, a1):
    """Annular sector, clockwise on screen from a0 to a1 (0 = right, 90 = down)."""
    lg = 1 if a1 - a0 > 180 else 0
    (x0, y0), (x1, y1) = pt(cx, cy, ro, a0), pt(cx, cy, ro, a1)
    (x2, y2), (x3, y3) = pt(cx, cy, ri, a1), pt(cx, cy, ri, a0)
    return (f'M{f(x0)} {f(y0)}A{f(ro)} {f(ro)} 0 {lg} 1 {f(x1)} {f(y1)}L{f(x2)} {f(y2)}'
            f'A{f(ri)} {f(ri)} 0 {lg} 0 {f(x3)} {f(y3)}Z')
def ring(cx, cy, ro, ri):
    return (f'M{f(cx-ro)} {f(cy)}A{f(ro)} {f(ro)} 0 1 1 {f(cx+ro)} {f(cy)}A{f(ro)} {f(ro)} 0 1 1 {f(cx-ro)} {f(cy)}Z'
            f'M{f(cx-ri)} {f(cy)}A{f(ri)} {f(ri)} 0 1 0 {f(cx+ri)} {f(cy)}A{f(ri)} {f(ri)} 0 1 0 {f(cx-ri)} {f(cy)}Z')
OV = 1.5                  # overshoot of round tops and bowls
RW = W + 1                # round strokes a touch heavier so they look equal to stems
def arch(x, d):           # stems + half-annulus, top at -OV
    ro = d/2; cy = ro - OV                 # flush with the stems: no bump at the joins
    return sector(x + d/2, cy, ro, ro - W, 180, 360), cy
def g_n(x):
    a, cy = arch(x, 74); return a + rect(x, cy, W, H-cy) + rect(x+74-W, cy, W, H-cy), 74
def g_m(x):
    d = 62; a1, cy = arch(x, d); a2, _ = arch(x+d-W, d)
    return a1 + a2 + ''.join(rect(x+k*(d-W), cy, W, H-cy) for k in range(3)), 2*d - W
def g_o(x):
    ro = H/2 + OV; return ring(x+ro, H/2, ro, ro-RW), 2*ro
def g_e(x):
    ro = H/2 + OV; cx = x+ro; bar = W*.9
    return sector(cx, H/2, ro, ro-RW, 38, 360) + rect(cx-ro+RW/2, H/2-bar/2, 2*ro-RW/2, bar), 2*ro
def g_t(x):
    arm = 17; return rect(x+arm, -30, W, H+30) + rect(x, 0, W+2*arm, W*.9), W + 2*arm
def g_r(x):
    _, cy = arch(x, 74); a = sector(x+37, cy, 37, 37-W, 180, 292)
    return a + rect(x, cy, W, H-cy), 37 + 37*math.cos(math.radians(292)) + 1
def g_i(x):
    return rect(x, 0, W, H) + ring(x+W/2, -26, W*.62, 0)[: ring(x+W/2, -26, W*.62, 0).index('ZM')+1], W
GLYPHS = {'m': (g_m, 13, 13), 'e': (g_e, 8, 6), 'n': (g_n, 13, 13), 't': (g_t, 2, 2),
          'o': (g_o, 8, 8), 'r': (g_r, 13, 2), 'i': (g_i, 13, 13)}
def word(text, space=44):
    d, x = '', 0
    for ch in text:
        if ch == ' ': x += space; continue
        fn, lsb, rsb = GLYPHS[ch]; p, adv = fn(x + lsb); d += p; x += lsb + adv + rsb
    return d, x           # wordmark spans y = -45 (i dot top) .. H

# --- write the set -----------------------------------------------------------------------
P = lambda d, fill=INK: f'<path fill="{fill}" d="{d}"/>'
sym = hourglass()
open(f'{OUT}/mm-symbol.svg', 'w').write(svg(256, 256, P(sym)))
open(f'{OUT}/mm-symbol-accent.svg', 'w').write(svg(256, 256, P(sym, ACCENT)))
open(f'{OUT}/mm-symbol-small.svg', 'w').write(svg(256, 256, P(hourglass(r=116, n=15))))
open(f'{OUT}/mm-symbol-reversed.svg', 'w').write(svg(256, 256, P(hourglass(r=107, n=8), '#FFFFFF')))

wd, ww = word('memento mori')
top = -42                 # i-dot top, rounded
wh = H - top
open(f'{OUT}/mm-wordmark.svg', 'w').write(svg(ww, wh, f'<g transform="translate(0 {-top})">{P(wd)}</g>'))

def lockups(sfill, wfill, tag):
    # horizontal: symbol 256 high; x-height = 0.4 of it, centred on the symbol's waist
    k = 0.4 * 256 / H; gap = 60
    hz = (P(sym, sfill) + f'<g transform="translate({256+gap} {f(128 - k*H/2)}) scale({f(k)})">{P(wd, wfill)}</g>')
    open(f'{OUT}/mm-horizontal{tag}.svg', 'w').write(svg(256 + gap + ww*k, 256, hz))
    # stacked: symbol centred above the wordmark, which is 2.4 symbol-widths wide
    k2 = 2.4 * 256 / ww; W2 = ww * k2; g2 = 52
    st = (f'<g transform="translate({f((W2-256)/2)} 0)">{P(sym, sfill)}</g>'
          f'<g transform="translate(0 {f(256 + g2 - top*k2)}) scale({f(k2)})">{P(wd, wfill)}</g>')
    open(f'{OUT}/mm-stacked{tag}.svg', 'w').write(svg(W2, 256 + g2 + wh*k2, st))
lockups(INK, INK, '')
lockups(ACCENT, INK, '-accent')
lockups('#FFFFFF', '#FFFFFF', '-reversed')
lockups('#0A84FF', '#F5F5F7', '-dark')          # the app's dark accent and text: README on a dark theme
print('ok', f(ww), f(wh))
