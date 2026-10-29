#!/usr/bin/env python3
"""Generate docs/images/architecture.svg from the vendored official AWS
architecture icons in docs/images/icons/.

The icons are inlined as nested <svg> elements (not <image href=...>) so the
composite renders on GitHub, which blocks external/relative image references in
Markdown-embedded SVG. Re-run this script after editing layout or swapping icons:

    python3 docs/images/gen-architecture.py
"""
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ICONS = HERE / "icons"

# ---- icon inlining -------------------------------------------------------
_svg_open = re.compile(r"<svg\b[^>]*>", re.I)
_viewbox = re.compile(r'viewBox="([^"]+)"', re.I)


def icon_inner(name):
    """Return (viewBox, inner_markup) for a vendored icon."""
    raw = (ICONS / name).read_text()
    raw = re.sub(r"<\?xml[^>]*\?>", "", raw)
    m = _svg_open.search(raw)
    vb_m = _viewbox.search(m.group(0))
    vb = vb_m.group(1) if vb_m else "0 0 80 80"
    inner = raw[m.end():]
    inner = inner[: inner.rfind("</svg>")]
    return vb, inner.strip()


def place_icon(name, x, y, size):
    """Nested <svg> that draws icon `name` at (x,y) scaled to size x size."""
    vb, inner = icon_inner(name)
    return (
        f'<svg x="{x}" y="{y}" width="{size}" height="{size}" '
        f'viewBox="{vb}" overflow="visible">{inner}</svg>'
    )


# ---- small drawing helpers ----------------------------------------------
FONT = "font-family='Amazon Ember, Helvetica, Arial, sans-serif'"
INK = "#232F3E"      # AWS squid ink
SUB = "#5A6B7B"      # muted label
LINE = "#687078"     # default connector
FLOW = "#1A73E8"     # forward data flow (blue)
FEED = "#00A1A1"     # feedback / evidence (teal)
parts = []


def tile(name, cx, icon_top, size, lines, label_color=INK):
    """Centered icon with wrapped label lines beneath it."""
    x = cx - size / 2
    parts.append(place_icon(name, x, icon_top, size))
    ty = icon_top + size + 14
    for i, ln in enumerate(lines):
        weight = "600" if i == 0 else "400"
        col = label_color if i == 0 else SUB
        parts.append(
            f'<text x="{cx}" y="{ty + i*15}" text-anchor="middle" {FONT} '
            f'font-size="13" font-weight="{weight}" fill="{col}">{ln}</text>'
        )


def group(x, y, w, h, title):
    parts.append(
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" '
        f'fill="#F4F6F8" stroke="#D5DBDB" stroke-width="1.5"/>'
    )
    parts.append(
        f'<text x="{x+16}" y="{y+22}" {FONT} font-size="13" font-weight="700" '
        f'fill="{INK}">{title}</text>'
    )


def edge(x1, y1, x2, y2, color=FLOW, dashed=False, curve=None):
    dash = ' stroke-dasharray="6 5"' if dashed else ""
    if curve:
        d = f'M {x1} {y1} C {curve[0]} {curve[1]} {curve[2]} {curve[3]} {x2} {y2}'
        parts.append(
            f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2"{dash} '
            f'marker-end="url(#arrow-{ "feed" if color==FEED else "flow" })"/>'
        )
    else:
        parts.append(
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" '
            f'stroke-width="2"{dash} marker-end="url(#arrow-'
            f'{ "feed" if color==FEED else "flow" })"/>'
        )


def elabel(x, y, text, color=SUB, anchor="middle"):
    parts.append(
        f'<text x="{x}" y="{y}" text-anchor="{anchor}" {FONT} font-size="12" '
        f'font-style="italic" fill="{color}">{text}</text>'
    )


# ---- canvas --------------------------------------------------------------
W, H = 1100, 820
parts.append(
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
    f'viewBox="0 0 {W} {H}" font-family="Amazon Ember, Helvetica, Arial, sans-serif">'
)
parts.append(
    '<defs>'
    f'<marker id="arrow-flow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
    f'markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{FLOW}"/></marker>'
    f'<marker id="arrow-feed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
    f'markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{FEED}"/></marker>'
    '</defs>'
)
parts.append(f'<rect x="0" y="0" width="{W}" height="{H}" fill="#FFFFFF"/>')
parts.append(
    f'<text x="40" y="38" {FONT} font-size="19" font-weight="700" fill="{INK}">'
    f'Autonomous monitoring — Amazon OpenSearch Service &amp; AWS DevOps Agent</text>'
)

# ---- groups --------------------------------------------------------------
group(150, 60, 220, 150, "Telemetry source")
group(150, 240, 820, 170, "Observability platform  (Part 1)")
group(360, 450, 610, 150, "Detection + signal bridge  (Part 2)")
group(150, 630, 820, 170, "Autonomous investigation  (Part 2)")

# ---- nodes (placed on a 3-column grid so every edge is H or V) -----------
IC = 60
# Telemetry
tile("amazon-ec2.svg", 260, 90, IC, ["Amazon EC2", "OTel demo + Collector"])
# Platform
tile("amazon-opensearch-ingestion.svg", 260, 270, IC, ["Amazon OpenSearch", "Ingestion"])
tile("amazon-opensearch-service.svg", 560, 270, IC, ["Amazon OpenSearch", "Service"])
tile("amazon-managed-prometheus.svg", 860, 270, IC, ["Amazon Managed Service", "for Prometheus"])
# Detection + bridge
tile("amazon-sns.svg", 560, 480, IC, ["Amazon SNS"])
tile("aws-lambda.svg", 860, 480, IC, ["AWS Lambda", "Signal Bridge"])
# Investigation
tile("aws-devops-agent.svg", 860, 665, IC, ["AWS DevOps Agent", "investigation + RCA"])
# MCP server = ECS on Fargate (two icons, one tile)
parts.append(place_icon("amazon-ecs.svg", 210, 670, 50))
parts.append(place_icon("aws-fargate.svg", 270, 670, 50))
parts.append(
    f'<text x="265" y="738" text-anchor="middle" {FONT} font-size="13" '
    f'font-weight="600" fill="{INK}">OpenSearch MCP server</text>'
)
parts.append(
    f'<text x="265" y="753" text-anchor="middle" {FONT} font-size="13" '
    f'fill="{SUB}">Amazon ECS on AWS Fargate (VPC-private, TLS)</text>'
)


# ---- orthogonal edge router ---------------------------------------------
def ortho(pts, color=FLOW, dashed=False):
    """Draw an axis-aligned polyline (horizontal/vertical segments only)."""
    dash = ' stroke-dasharray="6 5"' if dashed else ""
    d = "M " + " L ".join(f"{x} {y}" for x, y in pts)
    marker = "feed" if color == FEED else "flow"
    parts.append(
        f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2"{dash} '
        f'stroke-linejoin="round" marker-end="url(#arrow-{marker})"/>'
    )


# ---- edges (all strictly horizontal / vertical) --------------------------
# EC2 -> Amazon OpenSearch Ingestion   (vertical)
ortho([(260, 196), (260, 270)])
elabel(276, 234, "OTLP · SigV4", anchor="start")
# EC2 -> Amazon Managed Service for Prometheus   (right, then down)
ortho([(290, 120), (860, 120), (860, 270)])
elabel(600, 112, "remote_write · SigV4")
# Amazon OpenSearch Ingestion -> Amazon OpenSearch Service   (horizontal)
ortho([(290, 300), (530, 300)])
# Amazon OpenSearch Service -> Amazon SNS   (vertical)
ortho([(556, 330), (556, 480)])
elabel(548, 410, "Alerting breach", anchor="end")
# Amazon Managed Service for Prometheus -> Amazon SNS   (down, left, down)
ortho([(860, 330), (860, 418), (578, 418), (578, 480)])
elabel(720, 410, "AMP rule breach")
# Amazon SNS -> AWS Lambda   (horizontal)
ortho([(590, 510), (830, 510)])
elabel(710, 502, "notify")
# AWS Lambda -> AWS DevOps Agent   (vertical)
ortho([(860, 540), (860, 665)])
elabel(868, 608, "HMAC-SHA256 webhook", anchor="start")
# AWS DevOps Agent -> OpenSearch MCP server   (horizontal, right to left)
ortho([(830, 695), (322, 695)])
elabel(560, 687, "AWS::DevOpsAgent::PrivateConnection")
# MCP -> Amazon OpenSearch Service  (feedback: left margin, up, across the top)
ortho([(210, 695), (120, 695), (120, 225), (560, 225), (560, 270)],
      color=FEED, dashed=True)
elabel(132, 452, "evidence", color=FEED, anchor="start")
elabel(132, 468, "logs · traces · PPL", color=FEED, anchor="start")

# ---- legend --------------------------------------------------------------
ly = 785
parts.append(f'<line x1="700" y1="{ly-4}" x2="730" y2="{ly-4}" stroke="{FLOW}" stroke-width="2" marker-end="url(#arrow-flow)"/>')
parts.append(f'<text x="736" y="{ly}" {FONT} font-size="12" fill="{SUB}">telemetry / signal flow</text>')
parts.append(f'<line x1="890" y1="{ly-4}" x2="920" y2="{ly-4}" stroke="{FEED}" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#arrow-feed)"/>')
parts.append(f'<text x="926" y="{ly}" {FONT} font-size="12" fill="{SUB}">on-demand evidence</text>')

parts.append("</svg>")

out = HERE / "architecture.svg"
out.write_text("\n".join(parts) + "\n")
print(f"wrote {out} ({out.stat().st_size} bytes)")
