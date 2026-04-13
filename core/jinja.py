from fastapi.templating import Jinja2Templates

# Single shared template environment — all page routers import this
# instead of creating separate Jinja2Templates instances.
templates = Jinja2Templates(directory="templates")

LIB_VERSIONS = {
    "bootstrap": "5.3.8",
    "jquery": "3.7.1",
    "fontawesome": "6.7.2",
    "dayjs": "1",
    "flatpickr": "4.6.13",
    "chartjs": "4.5.1",
    "datatables": "2.3.6",
    "deck_gl": "9.2.7",
    "mapbox_gl": "3.17.0",
    "mapbox_gl_draw": "1.5.0",
    "topojson": "3",
}

CDN = {
    "bootstrap_css": f"https://cdn.jsdelivr.net/npm/bootstrap@{LIB_VERSIONS['bootstrap']}/dist/css/bootstrap.min.css",
    "bootstrap_js": f"https://cdn.jsdelivr.net/npm/bootstrap@{LIB_VERSIONS['bootstrap']}/dist/js/bootstrap.bundle.min.js",
    "fontawesome": f"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/{LIB_VERSIONS['fontawesome']}/css/all.min.css",
    "jquery": f"https://code.jquery.com/jquery-{LIB_VERSIONS['jquery']}.min.js",
    "dayjs": f"https://cdn.jsdelivr.net/npm/dayjs@{LIB_VERSIONS['dayjs']}/dayjs.min.js",
    "dayjs_relativeTime": f"https://cdn.jsdelivr.net/npm/dayjs@{LIB_VERSIONS['dayjs']}/plugin/relativeTime.js",
    "dayjs_duration": f"https://cdn.jsdelivr.net/npm/dayjs@{LIB_VERSIONS['dayjs']}/plugin/duration.js",
    "dayjs_weekOfYear": f"https://cdn.jsdelivr.net/npm/dayjs@{LIB_VERSIONS['dayjs']}/plugin/weekOfYear.js",
    "dayjs_isoWeek": f"https://cdn.jsdelivr.net/npm/dayjs@{LIB_VERSIONS['dayjs']}/plugin/isoWeek.js",
    "dayjs_isBetween": f"https://cdn.jsdelivr.net/npm/dayjs@{LIB_VERSIONS['dayjs']}/plugin/isBetween.js",
    "flatpickr_css": f"https://cdn.jsdelivr.net/npm/flatpickr@{LIB_VERSIONS['flatpickr']}/dist/flatpickr.min.css",
    "flatpickr_js": f"https://cdn.jsdelivr.net/npm/flatpickr@{LIB_VERSIONS['flatpickr']}/dist/flatpickr.min.js",
    "chartjs": f"https://cdn.jsdelivr.net/npm/chart.js@{LIB_VERSIONS['chartjs']}/dist/chart.umd.min.js",
    "datatables_css": f"https://cdn.datatables.net/{LIB_VERSIONS['datatables']}/css/dataTables.dataTables.min.css",
    "datatables_js": f"https://cdn.datatables.net/{LIB_VERSIONS['datatables']}/js/dataTables.min.js",
    "deck_gl": f"https://cdn.jsdelivr.net/npm/deck.gl@{LIB_VERSIONS['deck_gl']}/dist.min.js",
    "mapbox_gl_css": f"https://api.mapbox.com/mapbox-gl-js/v{LIB_VERSIONS['mapbox_gl']}/mapbox-gl.css",
    "mapbox_gl_js": f"https://api.mapbox.com/mapbox-gl-js/v{LIB_VERSIONS['mapbox_gl']}/mapbox-gl.js",
    "mapbox_draw_css": f"https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-draw/v{LIB_VERSIONS['mapbox_gl_draw']}/mapbox-gl-draw.css",
    "mapbox_draw_js": f"https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-draw/v{LIB_VERSIONS['mapbox_gl_draw']}/mapbox-gl-draw.js",
    "topojson": f"https://cdn.jsdelivr.net/npm/topojson-client@{LIB_VERSIONS['topojson']}/dist/topojson-client.min.js",
}


def format_number_filter(value: float | None) -> str:
    """Format a number with K/M suffix for large numbers."""
    if value is None:
        return "0"
    try:
        num = float(value)
        if num >= 1_000_000:
            return f"{num / 1_000_000:.1f}M"
        if num >= 1_000:
            return f"{num / 1_000:.1f}K"
        return str(int(num))
    except (ValueError, TypeError):
        return str(value)


def register_template_filters(tpl: Jinja2Templates | None = None) -> None:
    """Register shared Jinja filters on the template environment."""
    target = tpl or templates
    if "format_number" not in target.env.filters:
        target.env.filters["format_number"] = format_number_filter


def register_template_globals(tpl: Jinja2Templates | None = None) -> None:
    """Register shared template globals used across base/layout templates."""
    target = tpl or templates
    target.env.globals.setdefault("LIB_VERSIONS", LIB_VERSIONS)
    target.env.globals.setdefault("CDN", CDN)


# Auto-register on the shared instance at import time.
register_template_filters()
register_template_globals()
