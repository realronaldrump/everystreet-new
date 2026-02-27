from fastapi.templating import Jinja2Templates

# Single shared template environment — all page routers import this
# instead of creating separate Jinja2Templates instances.
templates = Jinja2Templates(directory="templates")


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


# Auto-register on the shared instance at import time.
register_template_filters()
